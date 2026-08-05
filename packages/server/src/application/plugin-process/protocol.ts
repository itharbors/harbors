export const PLUGIN_PROCESS_PROTOCOL = 1 as const;

const MAX_PAYLOAD_DEPTH = 32;
const MAX_PAYLOAD_BYTES = 1024 * 1024;

export interface PluginProcessErrorPayload {
  code: string;
  message: string;
  retryable?: boolean;
  retryAfterMs?: number;
}

export interface PluginProcessRequest {
  protocol: typeof PLUGIN_PROCESS_PROTOCOL;
  generation: string;
  kind: 'request';
  requestId: string;
  method: string;
  payload: unknown;
}

export interface PluginProcessResponseSuccess {
  protocol: typeof PLUGIN_PROCESS_PROTOCOL;
  generation: string;
  kind: 'response';
  requestId: string;
  ok: true;
  payload: unknown;
}

export interface PluginProcessResponseFailure {
  protocol: typeof PLUGIN_PROCESS_PROTOCOL;
  generation: string;
  kind: 'response';
  requestId: string;
  ok: false;
  error: PluginProcessErrorPayload;
}

export type PluginProcessResponse = PluginProcessResponseSuccess | PluginProcessResponseFailure;

export interface PluginProcessEvent {
  protocol: typeof PLUGIN_PROCESS_PROTOCOL;
  generation: string;
  kind: 'event';
  event: string;
  payload: unknown;
}

export type PluginProcessEnvelope = PluginProcessRequest | PluginProcessResponse | PluginProcessEvent;

export function assertPluginProcessPayload<T>(input: T): T {
  walkPayload(input, 0, new WeakSet<object>());
  const serialized = JSON.stringify(input);
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new TypeError('Plugin process payload exceeds 1 MiB');
  }
  return input;
}

export function parsePluginProcessEnvelope(input: unknown, expectedGeneration: string): PluginProcessEnvelope {
  if (!isPlainObject(input)) {
    throw new TypeError('Plugin process envelope must be a plain object');
  }

  const common = ['protocol', 'generation', 'kind'] as const;
  if (!hasExactFields(input, common)
    && !hasExactFields(input, [...common, 'requestId', 'method', 'payload'])
    && !hasExactFields(input, [...common, 'requestId', 'ok', 'payload'])
    && !hasExactFields(input, [...common, 'requestId', 'ok', 'error'])
    && !hasExactFields(input, [...common, 'event', 'payload'])) {
    throw new TypeError('Plugin process envelope has unknown or missing fields');
  }

  if (input.protocol !== PLUGIN_PROCESS_PROTOCOL) {
    throw new TypeError('Plugin process protocol version is not supported');
  }
  if (input.generation !== expectedGeneration) {
    throw new TypeError('Plugin process envelope generation is stale');
  }

  switch (input.kind) {
    case 'request':
      if (!hasExactFields(input, [...common, 'requestId', 'method', 'payload'])
        || !isNonEmptyString(input.requestId) || !isNonEmptyString(input.method)) {
        throw new TypeError('Plugin process request is invalid');
      }
      assertPluginProcessPayload(input.payload);
      return input as unknown as PluginProcessRequest;
    case 'response':
      if (input.ok === true && hasExactFields(input, [...common, 'requestId', 'ok', 'payload'])
        && isNonEmptyString(input.requestId)) {
        assertPluginProcessPayload(input.payload);
        return input as unknown as PluginProcessResponseSuccess;
      }
      if (input.ok === false && hasExactFields(input, [...common, 'requestId', 'ok', 'error'])
        && isNonEmptyString(input.requestId) && isPluginProcessErrorPayload(input.error)) {
        return input as unknown as PluginProcessResponseFailure;
      }
      throw new TypeError('Plugin process response is invalid');
    case 'event':
      if (!hasExactFields(input, [...common, 'event', 'payload']) || !isNonEmptyString(input.event)) {
        throw new TypeError('Plugin process event is invalid');
      }
      assertPluginProcessPayload(input.payload);
      return input as unknown as PluginProcessEvent;
    default:
      throw new TypeError('Plugin process envelope kind is invalid');
  }
}

function walkPayload(input: unknown, depth: number, seen: WeakSet<object>): void {
  if (depth > MAX_PAYLOAD_DEPTH) {
    throw new TypeError('Plugin process payload exceeds maximum depth');
  }
  if (input === null || typeof input === 'string' || typeof input === 'boolean') {
    return;
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      throw new TypeError('Plugin process payload numbers must be finite');
    }
    return;
  }
  if (typeof input !== 'object') {
    throw new TypeError('Plugin process payload must be structured-clone-compatible');
  }
  if (seen.has(input)) {
    throw new TypeError('Plugin process payload cannot contain cycles');
  }
  seen.add(input);

  if (Array.isArray(input)) {
    validateArray(input, depth, seen);
    return;
  }
  if (!isPlainObject(input)) {
    throw new TypeError('Plugin process payload objects must have a plain or null prototype');
  }
  for (const key of ownEnumerableDataKeys(input)) {
    walkPayload(input[key], depth + 1, seen);
  }
}

function validateArray(input: unknown[], depth: number, seen: WeakSet<object>): void {
  const keys = Reflect.ownKeys(input);
  for (const key of keys) {
    if (key === 'length') {
      continue;
    }
    if (typeof key !== 'string' || !isArrayIndex(key, input.length)) {
      throw new TypeError('Plugin process payload arrays cannot have custom properties');
    }
  }
  for (let index = 0; index < input.length; index += 1) {
    if (!Object.hasOwn(input, index)) {
      throw new TypeError('Plugin process payload arrays cannot contain holes');
    }
    walkPayload(input[index], depth + 1, seen);
  }
}

function isPluginProcessErrorPayload(input: unknown): input is PluginProcessErrorPayload {
  if (!isPlainObject(input)) {
    return false;
  }
  const allowed = ['code', 'message', 'retryable', 'retryAfterMs'];
  const keys = ownEnumerableDataKeys(input);
  if (!keys.includes('code') || !keys.includes('message') || keys.some((key) => !allowed.includes(key))) {
    return false;
  }
  return isNonEmptyString(input.code)
    && typeof input.message === 'string'
    && (input.retryable === undefined || typeof input.retryable === 'boolean')
    && (input.retryAfterMs === undefined || (typeof input.retryAfterMs === 'number'
      && Number.isFinite(input.retryAfterMs) && input.retryAfterMs >= 0));
}

function isPlainObject(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

function hasExactFields(input: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = ownEnumerableDataKeys(input);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function ownEnumerableDataKeys(input: Record<string, unknown>): string[] {
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== 'string')) {
    throw new TypeError('Plugin process data cannot contain symbol fields');
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('Plugin process data must have enumerable value fields');
    }
  }
  return keys as string[];
}

function isNonEmptyString(input: unknown): input is string {
  return typeof input === 'string' && input.length > 0;
}

function isArrayIndex(key: string, length: number): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}
