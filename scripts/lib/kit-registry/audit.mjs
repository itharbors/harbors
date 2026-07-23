import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';

const EVENTS = [
  'registry.refresh',
  'kit.install',
  'kit.reject',
  'kit.activate',
  'kit.rollback',
];
const OUTCOMES = ['success', 'failure'];
const SOURCES = ['network', 'cache', 'local'];
const KIT_ID_PATTERN = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

function exactObject(value, allowed, context) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${context} must be an object`);
  }
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${context} contains unexpected field ${unknown}`);
  return value;
}

function enumValue(value, allowed, context) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`${context} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

function timestamp(value) {
  if (typeof value !== 'string') throw new Error('Audit timestamp must be an ISO-8601 UTC timestamp');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error('Audit timestamp must be an ISO-8601 UTC timestamp');
  }
  return value;
}

function parseKit(value) {
  const input = exactObject(value, ['id', 'version', 'channel'], 'Audit Kit');
  if (typeof input.id !== 'string' || !KIT_ID_PATTERN.test(input.id)) {
    throw new Error('Audit Kit id must be a lowercase scoped package id');
  }
  if (typeof input.version !== 'string' || !VERSION_PATTERN.test(input.version)) {
    throw new Error('Audit Kit version must be a SemVer version');
  }
  return {
    id: input.id,
    version: input.version,
    channel: enumValue(input.channel, ['stable', 'preview'], 'Audit Kit channel'),
  };
}

function parseEntry(value, now) {
  const input = exactObject(
    value,
    ['event', 'outcome', 'kit', 'code', 'source'],
    'Audit entry',
  );
  const code = input.code;
  if (code !== undefined && (typeof code !== 'string' || !CODE_PATTERN.test(code))) {
    throw new Error('Audit code must be an uppercase machine-readable code');
  }
  return {
    timestamp: timestamp(now()),
    event: enumValue(input.event, EVENTS, 'Audit event'),
    outcome: enumValue(input.outcome, OUTCOMES, 'Audit outcome'),
    ...(input.kit === undefined ? {} : { kit: parseKit(input.kit) }),
    ...(code === undefined ? {} : { code }),
    ...(input.source === undefined
      ? {}
      : { source: enumValue(input.source, SOURCES, 'Audit source') }),
  };
}

export class KitAuditLog {
  #root;
  #file;
  #now;
  #queue = Promise.resolve();

  constructor(storeRoot, { now = () => new Date().toISOString() } = {}) {
    if (typeof storeRoot !== 'string' || storeRoot.length === 0) {
      throw new TypeError('Store root is required');
    }
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.#root = path.resolve(storeRoot);
    this.#file = path.join(this.#root, 'audit.ndjson');
    this.#now = now;
  }

  #enqueue(operation) {
    const result = this.#queue.then(operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async append(value) {
    return this.#enqueue(async () => {
      const entry = parseEntry(value, this.#now);
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      const handle = await open(this.#file, 'a', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(entry)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      return structuredClone(entry);
    });
  }
}
