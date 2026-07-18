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
    const methodList = Array.isArray(methods) ? methods : (typeof methods === 'string' ? [methods] : []);
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
    const methodList = Array.isArray(methods) ? methods : (typeof methods === 'string' ? [methods] : []);
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
  return runtime.plugin.callPlugin(pluginName, method, ...restArgs);
}

function dispatchBroadcast(pluginName: string, methods: string[], args: unknown[]) {
  for (const method of methods) {
    if (method.startsWith('panel.')) continue;
    runtime.plugin.callPlugin(pluginName, method, ...args);
  }
}

function dispatchWildcardRequest(pluginName: string, methods: string[], args: unknown[]) {
  for (const method of methods) {
    if (method.startsWith('panel.')) continue;
    return runtime.plugin.callPlugin(pluginName, method, ...args);
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
