import { open, mkdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';

import { parseInstalledKitState } from '@itharbors/kit-core';

function emptyState() {
  return { schemaVersion: 1, kits: {} };
}

function canonicalJson(value) {
  const sort = (input) => {
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sort(child)]));
    }
    return input;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

function clone(value) {
  return structuredClone(value);
}

async function syncDirectory(root) {
  try {
    const directory = await open(root, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (!['EINVAL', 'EPERM', 'EISDIR'].includes(error?.code)) throw error;
  }
}

export class InstalledKitStore {
  #root;
  #stateFile;
  #now;
  #syncDirectory;
  #state;
  #queue = Promise.resolve();
  #sequence = 0;

  constructor(root, {
    now = () => new Date().toISOString(),
    syncDirectory: syncDirectoryAdapter = syncDirectory,
  } = {}) {
    if (typeof root !== 'string' || root.length === 0) throw new TypeError('Store root is required');
    if (typeof syncDirectoryAdapter !== 'function') throw new TypeError('Directory sync adapter is required');
    this.#root = path.resolve(root);
    this.#stateFile = path.join(this.#root, 'installed.json');
    this.#now = now;
    this.#syncDirectory = syncDirectoryAdapter;
  }

  #enqueue(operation) {
    const result = this.#queue.then(operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async #load() {
    if (this.#state) return this.#state;
    await mkdir(this.#root, { recursive: true });
    let raw;
    try {
      raw = await readFile(this.#stateFile, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.#state = emptyState();
        return this.#state;
      }
      throw error;
    }
    try {
      this.#state = parseInstalledKitState(JSON.parse(raw));
    } catch {
      const timestamp = this.#now().replace(/[^0-9A-Za-z.-]/gu, '-');
      await rename(this.#stateFile, `${this.#stateFile}.corrupt-${timestamp}-${this.#sequence += 1}`);
      this.#state = emptyState();
    }
    return this.#state;
  }

  async #persist(state) {
    const validated = parseInstalledKitState(state);
    const temporary = `${this.#stateFile}.tmp-${process.pid}-${this.#sequence += 1}`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(canonicalJson(validated), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.#stateFile);
    this.#state = validated;
    try {
      await this.#syncDirectory(this.#root);
    } catch {
      // The atomic rename is the commit point. Reporting failure now could make
      // callers delete files referenced by the already-committed state.
    }
  }

  async snapshot() {
    return this.#enqueue(async () => clone(await this.#load()));
  }

  async recordInstalled({ id, version, directory, digest, source, channel }) {
    return this.#enqueue(async () => {
      const state = clone(await this.#load());
      const existingRecord = state.kits[id];
      const existingVersion = existingRecord?.versions?.[version];
      if (existingVersion) {
        if (existingVersion.digest !== digest) {
          throw new Error(`Installed Kit ${id}@${version} is immutable and has a different digest`);
        }
        return clone(existingVersion);
      }
      const record = existingRecord ?? {
        channel,
        autoUpdate: false,
        versions: {},
        badVersions: [],
      };
      record.channel = channel;
      record.versions[version] = {
        version,
        directory,
        digest,
        source: clone(source),
        installedAt: this.#now(),
      };
      state.kits[id] = record;
      await this.#persist(state);
      return clone(record.versions[version]);
    });
  }

  async #mutateRecord(id, operation) {
    return this.#enqueue(async () => {
      const state = clone(await this.#load());
      const record = state.kits[id];
      if (!record) throw new Error(`Kit ${id} is not installed`);
      const result = operation(record);
      await this.#persist(state);
      return result;
    });
  }

  async setPending(id, version, { retryBad = false } = {}) {
    if (typeof retryBad !== 'boolean') throw new TypeError('retryBad must be a boolean');
    return this.#mutateRecord(id, (record) => {
      if (!record.versions[version]) throw new Error(`Kit ${id}@${version} is not installed`);
      if (record.badVersions.includes(version) && !retryBad) {
        throw new Error(`Kit ${id}@${version} is marked bad and requires an explicit retry`);
      }
      record.pending = version;
    });
  }

  async activate(id, version) {
    return this.#mutateRecord(id, (record) => {
      if (!record.versions[version]) throw new Error(`Kit ${id}@${version} is not installed`);
      if (record.active && record.active !== version) record.previous = record.active;
      record.active = version;
      if (record.pending === version) delete record.pending;
      record.badVersions = record.badVersions.filter((candidate) => candidate !== version);
    });
  }

  async stageActivation(id, version) {
    return this.#mutateRecord(id, (record) => {
      if (!record.versions[version]) throw new Error(`Kit ${id}@${version} is not installed`);
      if (record.pending !== version) {
        throw new Error(`Kit ${id} pending version does not match ${version}`);
      }
      if (record.active && record.active !== version) record.previous = record.active;
      record.active = version;
    });
  }

  async commitActivation(id, version) {
    return this.#mutateRecord(id, (record) => {
      if (record.active !== version || record.pending !== version) {
        throw new Error(`Kit ${id}@${version} is not the staged pending activation`);
      }
      delete record.pending;
      record.badVersions = record.badVersions.filter((candidate) => candidate !== version);
    });
  }

  async failActivation(id, version) {
    return this.#mutateRecord(id, (record) => {
      if (!record.versions[version]) throw new Error(`Kit ${id}@${version} is not installed`);
      if (record.active !== version || record.pending !== version) {
        throw new Error(`Kit ${id}@${version} is not the staged pending activation`);
      }
      if (!record.badVersions.includes(version)) record.badVersions.push(version);
      const recoveryVersion = record.previous;
      if (
        recoveryVersion
        && record.versions[recoveryVersion]
        && !record.badVersions.includes(recoveryVersion)
      ) {
        record.active = recoveryVersion;
        record.pending = recoveryVersion;
        record.previous = version;
        return { status: 'recovery-pending', recoveryVersion };
      }
      delete record.active;
      delete record.pending;
      delete record.previous;
      return { status: 'disabled' };
    });
  }

  async clearPending(id, expectedVersion) {
    return this.#mutateRecord(id, (record) => {
      if (record.pending !== expectedVersion) {
        throw new Error(`Kit ${id} pending version does not match ${expectedVersion}`);
      }
      delete record.pending;
    });
  }

  async clearActive(id, expectedVersion) {
    return this.#mutateRecord(id, (record) => {
      if (record.active !== expectedVersion) {
        throw new Error(`Kit ${id} active version does not match ${expectedVersion}`);
      }
      delete record.active;
    });
  }

  async rollback(id) {
    return this.#mutateRecord(id, (record) => {
      if (!record.previous) throw new Error(`Kit ${id} has no previous version to roll back`);
      const oldActive = record.active;
      record.active = record.previous;
      if (oldActive) record.previous = oldActive;
      else delete record.previous;
      delete record.pending;
    });
  }

  async markBad(id, version) {
    return this.#mutateRecord(id, (record) => {
      if (!record.versions[version]) throw new Error(`Kit ${id}@${version} is not installed`);
      if (!record.badVersions.includes(version)) record.badVersions.push(version);
      if (record.pending === version) delete record.pending;
    });
  }

  async setAutoUpdate(id, enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('autoUpdate must be a boolean');
    return this.#mutateRecord(id, (record) => {
      record.autoUpdate = enabled;
    });
  }

  async listActiveSources() {
    return this.#enqueue(async () => {
      const state = await this.#load();
      return Object.entries(state.kits)
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([id, record]) => {
          const active = record.active && record.versions[record.active];
          if (!active) return [];
          return [{
            id,
            version: active.version,
            directory: active.directory,
            digest: active.digest,
            source: 'installed',
          }];
        });
    });
  }
}
