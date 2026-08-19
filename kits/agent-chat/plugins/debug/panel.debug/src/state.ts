export const MAX_MESSAGES = 2000;
export const MAX_PAYLOAD_CHARS = 12000;
export const MAX_STRING_CHARS = 4000;
export const MAX_DEPTH = 6;
export const MAX_COLLECTION_ITEMS = 100;

let messageIdCounter = 0;

export type RuntimeMessage = {
  id: string;
  type: string;
  payload: unknown;
  timestamp: number;
};

type RuntimeMessageInput = Omit<RuntimeMessage, 'id'> & { id?: string };

export type MessageMeta = {
  plugin?: unknown;
  name?: unknown;
  topic?: unknown;
};

export function appendMessage(messages: RuntimeMessage[], message: RuntimeMessageInput): RuntimeMessage[] {
  const id = typeof message.id === 'string' && message.id.length > 0
    ? message.id
    : `msg-${++messageIdCounter}`;
  const next = [...messages, { ...message, id }];
  return next.length > MAX_MESSAGES ? next.slice(-MAX_MESSAGES) : next;
}

export function createRequestMessage(meta: MessageMeta, args: unknown[], timestamp = Date.now()): RuntimeMessage {
  return {
    id: `msg-${++messageIdCounter}`,
    type: `Request ${formatRequest(meta)}`,
    payload: normalizeArgs(args),
    timestamp,
  };
}

export function createBroadcastMessage(meta: MessageMeta, args: unknown[], timestamp = Date.now()): RuntimeMessage {
  return {
    id: `msg-${++messageIdCounter}`,
    type: `Broadcast ${formatBroadcast(meta)}`,
    payload: normalizeArgs(args),
    timestamp,
  };
}

export function normalizeArgs(args: unknown[]): unknown {
  if (args.length === 0) return [];
  const normalized = args.length === 1
    ? trimValue(args[0])
    : args.map((arg) => trimValue(arg));
  try {
    const serialized = JSON.stringify(normalized);
    if (serialized && serialized.length > MAX_PAYLOAD_CHARS) {
      return cropString(serialized, MAX_PAYLOAD_CHARS);
    }
  } catch {
    return cropString(String(normalized), MAX_PAYLOAD_CHARS);
  }
  return normalized;
}

export function trimValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return cropString(value, MAX_STRING_CHARS);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value === undefined) return 'undefined';
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'function' || typeof value === 'symbol') return String(value);
  if (depth >= MAX_DEPTH) return '[内容层级已截断]';

  if (typeof value === 'object') {
    if (seen.has(value)) return '[循环引用已截断]';
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const items = value.slice(0, MAX_COLLECTION_ITEMS).map((item) => trimValue(item, depth + 1, seen));
        if (value.length > MAX_COLLECTION_ITEMS) items.push(`[其余 ${value.length - MAX_COLLECTION_ITEMS} 项已截断]`);
        return items;
      }

      const result: Record<string, unknown> = {};
      const keys = Object.keys(value);
      for (const key of keys.slice(0, MAX_COLLECTION_ITEMS)) {
        result[cropString(key, MAX_STRING_CHARS)] = trimValue((value as Record<string, unknown>)[key], depth + 1, seen);
      }
      if (keys.length > MAX_COLLECTION_ITEMS) result['…'] = `[其余 ${keys.length - MAX_COLLECTION_ITEMS} 个字段已截断]`;
      return result;
    } finally {
      seen.delete(value);
    }
  }

  return cropString(String(value), MAX_STRING_CHARS);
}

export function cropString(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

export function stringifyPayload(payload: unknown, pretty = false): string {
  if (typeof payload === 'string') return cropString(payload, MAX_PAYLOAD_CHARS);
  let result: string;
  try {
    result = JSON.stringify(payload, null, pretty ? 2 : 0) ?? String(payload);
  } catch {
    result = String(payload);
  }
  return cropString(result, MAX_PAYLOAD_CHARS);
}

function formatRequest(meta: MessageMeta): string {
  const plugin = typeof meta?.plugin === 'string' ? meta.plugin : 'unknown';
  const name = typeof meta?.name === 'string' ? meta.name : 'unknown';
  return `${plugin}.${name}`;
}

function formatBroadcast(meta: MessageMeta): string {
  return typeof meta?.topic === 'string' ? meta.topic : 'unknown';
}
