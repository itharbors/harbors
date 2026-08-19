export type MessageLocation = 'server' | 'browser';

export interface MessageRoute {
  plugin: string;
  name: string;
  methods: string[];
  callers?: string[];
  location: MessageLocation;
}

export interface MessageRequestRoute extends MessageRoute {
  handler: (...args: unknown[]) => Promise<unknown> | unknown;
}

export interface MessageBroadcastRoute extends MessageRoute {
  handler: (...args: unknown[]) => void | Promise<void>;
}

export interface MessageRegistry {
  request: Map<string, MessageRequestRoute>;
  broadcast: Map<string, MessageBroadcastRoute[]>;
}

export interface SSEDispatch {
  type: 'panel-dispatch';
  panel: string;
  method: string;
  args: unknown[];
  requestId?: string;
}

export interface DispatchResult {
  requestId: string;
  result?: unknown;
  error?: string;
}

export type MessageRouteDeclaration = readonly string[] | {
  readonly methods: readonly string[];
  readonly callers?: readonly string[];
};

export function normalizeMessageRouteDeclaration(value: MessageRouteDeclaration | unknown): {
  methods: string[];
  callers?: string[];
} {
  if (Array.isArray(value)) return { methods: [...value] };
  if (value === null || typeof value !== 'object' || !Array.isArray((value as { methods?: unknown }).methods)) {
    throw new Error('Message route declaration must be an array or an object with methods');
  }
  const input = value as { methods: readonly string[]; callers?: readonly string[] };
  const methods = [...input.methods];
  const callers = input.callers === undefined ? undefined : [...input.callers];
  if (methods.some((method) => typeof method !== 'string' || method.length === 0)) {
    throw new Error('Message route methods must be non-empty names');
  }
  if (callers && callers.length === 0) throw new Error('Message route callers must not be empty');
  if (callers && callers.some((caller) => typeof caller !== 'string' || caller.length === 0)) {
    throw new Error('Message route callers must be non-empty names');
  }
  if (callers && new Set(callers).size !== callers.length) {
    throw new Error('Message route callers contains duplicates');
  }
  return callers === undefined ? { methods } : { methods, callers };
}
