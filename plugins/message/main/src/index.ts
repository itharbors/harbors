let runtime: any;
const registered = new Map<string, { requests: string[]; broadcasts: string[] }>();

export function load(ed: any) {
  runtime = ed;
}

export function attach(pluginName: string, contribute: any) {
  const requests = contribute?.message?.request;
  const broadcasts = contribute?.message?.broadcast;
  if (!requests && !broadcasts) return;

  detach(pluginName);

  const state = {
    requests: [] as string[],
    broadcasts: [] as string[],
  };

  for (const [messageName, methods] of Object.entries(requests ?? {})) {
    const methodList = routeMethods(methods);
    if (methodList.length === 0) continue;

    runtime.message.registerRequest(
      pluginName,
      messageName,
      (...args: unknown[]) => messageName === '*'
        ? dispatchWildcardRequest(pluginName, methodList, args)
        : dispatchToPlugin(pluginName, messageName, methodList, args),
      'server',
      methodList,
    );
    state.requests.push(messageName);
  }

  for (const [topic, methods] of Object.entries(broadcasts ?? {})) {
    const methodList = routeMethods(methods);
    if (methodList.length === 0) continue;

    runtime.message.registerBroadcast(
      pluginName,
      topic,
      (...args: unknown[]) => dispatchBroadcast(pluginName, methodList, args),
      'server',
      methodList,
    );
    state.broadcasts.push(topic);
  }

  registered.set(pluginName, state);
}

function routeMethods(route: unknown): string[] {
  if (typeof route === 'string') return route.length > 0 ? [route] : [];

  const methods = route !== null && typeof route === 'object' && !Array.isArray(route)
    ? (route as { methods?: unknown }).methods
    : route;
  if (!Array.isArray(methods) || methods.length === 0) return [];
  if (methods.some((method) => typeof method !== 'string' || method.length === 0)) return [];
  return [...methods];
}

export function detach(pluginName: string) {
  const state = registered.get(pluginName);
  if (!state) return;

  for (const name of state.requests) {
    runtime.message.unregisterRequest(pluginName, name);
  }
  for (const topic of state.broadcasts) {
    runtime.message.unregisterBroadcast(pluginName, topic);
  }
  registered.delete(pluginName);
}

function dispatchToPlugin(pluginName: string, messageName: string, methods: string[], args: unknown[]) {
  const [method, restArgs] = resolveMethod(messageName, methods, args);
  return callPlugin(pluginName, method, restArgs);
}

function dispatchBroadcast(pluginName: string, methods: string[], args: unknown[]) {
  for (const method of methods) {
    if (method.startsWith('panel.')) continue;
    try {
      const result = callPlugin(pluginName, method, args);
      if (result && typeof result.then === 'function') {
        result.catch((err: unknown) => {
          // Normalized async rejection is consumed so it never becomes an
          // unhandledRejection. callPlugin already converted plain objects to
          // Error instances with readable messages.
          console.error('[message] broadcast handler failed:', err instanceof Error ? err.message : String(err));
        });
      }
    } catch (err) {
      // Normalized sync throw is consumed so it never bubbles up to the
      // MessageModule broadcast caller.
      console.error('[message] broadcast handler failed:', err instanceof Error ? err.message : String(err));
    }
  }
}

function dispatchWildcardRequest(pluginName: string, methods: string[], args: unknown[]) {
  for (const method of methods) {
    if (method.startsWith('panel.')) continue;
    return callPlugin(pluginName, method, args);
  }
}

function resolveMethod(messageName: string, methods: string[], args: unknown[]) {
  if (methods.length === 1) {
    return [methods[0], args] as const;
  }
  const [maybeMethod, ...restArgs] = args;
  if (typeof maybeMethod === 'string' && methods.includes(maybeMethod)) {
    return [maybeMethod, restArgs] as const;
  }
  throw new Error(
    `Message "${messageName}" maps to multiple methods (${methods.join(', ')}). Pass the target method name as the first argument.`,
  );
}

/**
 * Wrap a plugin call so that thrown/rejected non-Error values (e.g. plain
 * objects) are converted to Error instances carrying readable text instead of
 * surfacing as "[object Object]" upstream.
 */
function callPlugin(pluginName: string, method: string, args: unknown[]) {
  try {
    const result = runtime.plugin.callPlugin(pluginName, method, ...args);
    if (result && typeof result.then === 'function') {
      return result.catch((err: unknown) => {
        throw normalizeError(err);
      });
    }
    return result;
  } catch (err) {
    throw normalizeError(err);
  }
}

function normalizeError(err: unknown): Error {
  if (err instanceof Error) {
    return err;
  }

  return new Error(readableErrorMessage(err));
}

function readableErrorMessage(value: unknown, seen = new Set<object>()): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return 'Unknown error';
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  const record = value as Record<string, unknown>;
  for (const key of ['message', 'error', 'details', 'reason', 'msg']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
    if (candidate && typeof candidate === 'object') {
      const nested = readableErrorMessage(candidate, seen);
      if (nested && nested !== '[Circular]') return nested;
    }
  }

  try {
    const stringifySeen = new WeakSet<object>();
    const serialized = JSON.stringify(value, (_key, nested) => {
      if (typeof nested === 'object' && nested !== null) {
        if (stringifySeen.has(nested)) return '[Circular]';
        stringifySeen.add(nested);
      }
      if (typeof nested === 'function') return '[Function]';
      if (typeof nested === 'symbol') return nested.toString();
      if (typeof nested === 'bigint') return nested.toString();
      return nested;
    });
    return serialized || 'Unknown error';
  } catch {
    return 'Unable to serialize error object';
  }
}

declare const editor: any;

if (typeof editor !== 'undefined' && editor?.plugin?.define) {
  editor.plugin.define({
    lifecycle: {
      load,
      attach,
      detach,
    },
    methods: {},
  });
}
