import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { parseKitRegistryIndex } from '@itharbors/kit-core';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

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

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function clone(value) {
  return structuredClone(value);
}

function exactKeys(value, allowed, context) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${context} contains unexpected field ${unknown}`);
  return value;
}

function nonEmptyString(value, context) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
  return value;
}

function isoTimestamp(value, context) {
  const parsed = nonEmptyString(value, context);
  const timestamp = Date.parse(parsed);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== parsed) {
    throw new Error(`${context} must be an ISO-8601 UTC timestamp`);
  }
  return parsed;
}

function registryUrl(value) {
  const parsed = nonEmptyString(value, 'Registry cache URL');
  let url;
  try {
    url = new URL(parsed);
  } catch {
    throw new Error('Registry cache URL must be an absolute HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Registry cache URL must be an absolute HTTP(S) URL without credentials');
  }
  return parsed;
}

function parseMetadata(value) {
  const input = exactKeys(
    value,
    ['schemaVersion', 'registryUrl', 'etag', 'validatedAt', 'indexSha256'],
    'Registry cache metadata',
  );
  if (input.schemaVersion !== 1) {
    throw new Error(`Unsupported Registry cache schemaVersion: ${String(input.schemaVersion)}`);
  }
  const indexSha256 = nonEmptyString(input.indexSha256, 'Registry cache indexSha256');
  if (!SHA256_PATTERN.test(indexSha256)) {
    throw new Error('Registry cache indexSha256 must be a lowercase SHA-256 digest');
  }
  const etag = input.etag === undefined
    ? undefined
    : nonEmptyString(input.etag, 'Registry cache ETag');
  return {
    schemaVersion: 1,
    registryUrl: registryUrl(input.registryUrl),
    ...(etag === undefined ? {} : { etag }),
    validatedAt: isoTimestamp(input.validatedAt, 'Registry cache validatedAt'),
    indexSha256,
  };
}

export class KitRegistryCache {
  #directory;
  #indexFile;
  #metadataFile;
  #now;
  #queue = Promise.resolve();
  #sequence = 0;

  constructor(storeRoot, { now = () => new Date().toISOString() } = {}) {
    if (typeof storeRoot !== 'string' || storeRoot.length === 0) {
      throw new TypeError('Store root is required');
    }
    this.#directory = path.join(path.resolve(storeRoot), 'registry');
    this.#indexFile = path.join(this.#directory, 'index.v1.json');
    this.#metadataFile = path.join(this.#directory, 'metadata.json');
    this.#now = now;
  }

  #enqueue(operation) {
    const result = this.#queue.then(operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async #atomicWrite(destination, contents) {
    const temporary = `${destination}.tmp-${process.pid}-${this.#sequence += 1}`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      await handle.close();
      await rename(temporary, destination);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async #syncDirectory() {
    try {
      const directory = await open(this.#directory, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      if (!['EINVAL', 'EPERM', 'EISDIR'].includes(error?.code)) throw error;
    }
  }

  async #quarantine() {
    const suffix = `${this.#now().replace(/[^0-9A-Za-z.-]/gu, '-')}-${this.#sequence += 1}`;
    for (const file of [this.#indexFile, this.#metadataFile]) {
      try {
        await rename(file, `${file}.corrupt-${suffix}`);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }

  async read() {
    return this.#enqueue(async () => {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const [indexResult, metadataResult] = await Promise.allSettled([
        readFile(this.#indexFile, 'utf8'),
        readFile(this.#metadataFile, 'utf8'),
      ]);
      const bothMissing = indexResult.status === 'rejected'
        && metadataResult.status === 'rejected'
        && indexResult.reason?.code === 'ENOENT'
        && metadataResult.reason?.code === 'ENOENT';
      if (bothMissing) return null;
      try {
        if (indexResult.status === 'rejected') throw indexResult.reason;
        if (metadataResult.status === 'rejected') throw metadataResult.reason;
        const index = parseKitRegistryIndex(JSON.parse(indexResult.value));
        const metadata = parseMetadata(JSON.parse(metadataResult.value));
        if (digest(indexResult.value) !== metadata.indexSha256) {
          throw new Error('Registry cache index digest does not match metadata');
        }
        return clone({ index, metadata });
      } catch {
        await this.#quarantine();
        return null;
      }
    });
  }

  async writeVerified({ registryUrl: url, etag, index, validatedAt = this.#now() }) {
    return this.#enqueue(async () => {
      const parsedIndex = parseKitRegistryIndex(index);
      const indexContents = canonicalJson(parsedIndex);
      const metadata = parseMetadata({
        schemaVersion: 1,
        registryUrl: url,
        ...(etag === undefined ? {} : { etag }),
        validatedAt,
        indexSha256: digest(indexContents),
      });
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      await this.#atomicWrite(this.#indexFile, indexContents);
      await this.#atomicWrite(this.#metadataFile, canonicalJson(metadata));
      await this.#syncDirectory();
      return clone({ index: parsedIndex, metadata });
    });
  }
}
