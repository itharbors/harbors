const KIT_ID_PATTERN = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const AUDIT_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

function requireMethod(value, method, context) {
  if (!value || typeof value[method] !== 'function') {
    throw new TypeError(`${context}.${method} is required`);
  }
}

function parseInstallInput(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Kit install input must be an object');
  }
  const allowed = ['id', 'version', 'channel'];
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`Kit install input contains unexpected field ${unknown}`);
  if (typeof value.id !== 'string' || !KIT_ID_PATTERN.test(value.id)) {
    throw new Error('Kit install id must be a lowercase scoped package id');
  }
  if (typeof value.version !== 'string' || !VERSION_PATTERN.test(value.version)) {
    throw new Error('Kit install version must be a SemVer version');
  }
  if (!['stable', 'preview'].includes(value.channel)) {
    throw new Error('Kit install channel must be stable or preview');
  }
  return { id: value.id, version: value.version, channel: value.channel };
}

function parseActivationInput(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Kit activation input must be an object');
  }
  const allowed = ['id', 'version', 'retryBad'];
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`Kit activation input contains unexpected field ${unknown}`);
  if (typeof value.id !== 'string' || !KIT_ID_PATTERN.test(value.id)) {
    throw new Error('Kit activation id must be a lowercase scoped package id');
  }
  if (typeof value.version !== 'string' || !VERSION_PATTERN.test(value.version)) {
    throw new Error('Kit activation version must be a SemVer version');
  }
  if (value.retryBad !== undefined && typeof value.retryBad !== 'boolean') {
    throw new Error('Kit activation retryBad must be a boolean');
  }
  return { id: value.id, version: value.version, retryBad: value.retryBad ?? false };
}

function parseKitId(value) {
  if (typeof value !== 'string' || !KIT_ID_PATTERN.test(value)) {
    throw new Error('Kit id must be a lowercase scoped package id');
  }
  return value;
}

function installedProjection(record) {
  return {
    ...(record.active === undefined ? {} : { active: record.active }),
    ...(record.previous === undefined ? {} : { previous: record.previous }),
    ...(record.pending === undefined ? {} : { pending: record.pending }),
    channel: record.channel,
    autoUpdate: record.autoUpdate,
    versions: Object.keys(record.versions).sort((left, right) => left.localeCompare(right)),
    badVersions: [...record.badVersions],
  };
}

function sanitize(snapshot, installedState) {
  const kits = new Map();
  for (const kit of snapshot.index?.kits ?? []) {
    kits.set(kit.id, {
      id: kit.id,
      label: kit.label,
      publisher: kit.publisher,
      summary: kit.summary,
      channels: {
        ...(kit.channels.stable === undefined
          ? {}
          : { stable: {
            version: kit.channels.stable.version,
            permissions: [...kit.channels.stable.permissions],
          } }),
        ...(kit.channels.preview === undefined
          ? {}
          : { preview: {
            version: kit.channels.preview.version,
            permissions: [...kit.channels.preview.permissions],
          } }),
      },
    });
  }
  for (const [id, record] of Object.entries(installedState.kits)) {
    const existing = kits.get(id) ?? { id, channels: {} };
    kits.set(id, { ...existing, installed: installedProjection(record) });
  }
  return {
    source: snapshot.source,
    stale: snapshot.stale,
    validatedAt: snapshot.validatedAt,
    ...(snapshot.error === undefined ? {} : { error: structuredClone(snapshot.error) }),
    kits: [...kits.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function auditCode(error) {
  return typeof error?.code === 'string' && AUDIT_CODE_PATTERN.test(error.code)
    ? error.code
    : 'INSTALL_FAILED';
}

export class KitRegistryManager {
  #client;
  #resolver;
  #downloader;
  #installer;
  #store;
  #audit;
  #runtime;
  #autoUpdatePublishers;
  #kitQueues = new Map();

  constructor({
    client,
    resolver,
    downloader,
    installer,
    store,
    audit,
    runtime,
    autoUpdatePublishers = [],
  }) {
    requireMethod(client, 'snapshot', 'client');
    requireMethod(client, 'refresh', 'client');
    requireMethod(resolver, 'resolve', 'resolver');
    requireMethod(downloader, 'download', 'downloader');
    requireMethod(installer, 'installFromFile', 'installer');
    requireMethod(store, 'snapshot', 'store');
    requireMethod(store, 'setAutoUpdate', 'store');
    requireMethod(store, 'setPending', 'store');
    requireMethod(audit, 'append', 'audit');
    if (!runtime || typeof runtime !== 'object') throw new TypeError('runtime is required');
    if (!Array.isArray(autoUpdatePublishers)
      || autoUpdatePublishers.some((item) => typeof item !== 'string' || item.length === 0)) {
      throw new TypeError('autoUpdatePublishers must be an array of publisher names');
    }
    this.#client = client;
    this.#resolver = resolver;
    this.#downloader = downloader;
    this.#installer = installer;
    this.#store = store;
    this.#audit = audit;
    this.#runtime = structuredClone(runtime);
    this.#autoUpdatePublishers = new Set(autoUpdatePublishers);
  }

  async #safeAudit(entry) {
    await this.#audit.append(entry).catch(() => undefined);
  }

  async #project(snapshot) {
    return sanitize(snapshot, await this.#store.snapshot());
  }

  async list() {
    return this.#project(await this.#client.snapshot());
  }

  async refresh() {
    const snapshot = await this.#client.refresh({ force: true });
    const failed = snapshot.error !== undefined;
    await this.#safeAudit({
      event: 'registry.refresh',
      outcome: failed ? 'failure' : 'success',
      ...(['network', 'cache'].includes(snapshot.source) ? { source: snapshot.source } : {}),
      ...(failed ? { code: auditCode(snapshot.error) } : {}),
    });
    return this.#project(snapshot);
  }

  #enqueueKit(id, operation) {
    const previous = this.#kitQueues.get(id) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.#kitQueues.set(id, tail);
    tail.then(() => {
      if (this.#kitQueues.get(id) === tail) this.#kitQueues.delete(id);
    });
    return result;
  }

  async install(value) {
    const input = parseInstallInput(value);
    return this.#enqueueKit(input.id, async () => {
      try {
        const asset = await this.#resolver.resolve({ ...input, runtime: this.#runtime });
        const downloaded = await this.#downloader.download(asset);
        const installed = await this.#installer.installFromFile({
          archivePath: downloaded.path,
          expected: {
            id: asset.id,
            version: asset.version,
            publisher: asset.publisher,
            repository: asset.source.repository,
            commit: asset.source.commit,
            sha256: asset.sha256,
            size: asset.size,
          },
        });
        const autoUpdate = input.channel === 'stable'
          && this.#autoUpdatePublishers.has(asset.publisher);
        await this.#store.setAutoUpdate(input.id, autoUpdate);
        await this.#safeAudit({
          event: 'kit.install',
          outcome: 'success',
          source: 'network',
          kit: input,
        });
        return {
          status: installed.status,
          ...input,
          autoUpdate,
        };
      } catch (error) {
        await this.#safeAudit({
          event: 'kit.install',
          outcome: 'failure',
          source: 'network',
          kit: input,
          code: auditCode(error),
        });
        throw error;
      }
    });
  }

  async activate(value) {
    const input = parseActivationInput(value);
    return this.#enqueueKit(input.id, async () => {
      const state = await this.#store.snapshot();
      const record = state.kits[input.id];
      if (!record?.versions[input.version]) {
        throw new Error(`Kit ${input.id}@${input.version} is not installed`);
      }
      if (record.active === input.version && record.pending === undefined) {
        return {
          id: input.id, version: input.version, pending: false, requiresRestart: false,
        };
      }
      await this.#store.setPending(input.id, input.version, { retryBad: input.retryBad });
      return { id: input.id, version: input.version, pending: true, requiresRestart: true };
    });
  }

  async rollback(value) {
    const id = parseKitId(value);
    return this.#enqueueKit(id, async () => {
      const state = await this.#store.snapshot();
      const record = state.kits[id];
      if (!record?.previous) throw new Error(`Kit ${id} has no previous version to roll back`);
      await this.#store.setPending(id, record.previous);
      return { id, version: record.previous, pending: true, requiresRestart: true };
    });
  }
}
