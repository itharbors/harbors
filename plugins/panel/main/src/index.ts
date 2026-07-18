import path from 'node:path';

let runtime: any;
const registered = new Map<string, string[]>();

function normalizePanelContribution(pluginName: string, panelName: string, panelContribution: unknown) {
  if (!panelContribution || typeof panelContribution !== 'object') {
    throw new Error(`Panel contribution "${pluginName}.${panelName}" must be an object with an entry field`);
  }

  const definition = panelContribution as {
    entry?: unknown;
    title?: unknown;
    titleKey?: unknown;
    width?: unknown;
    height?: unknown;
    minWidth?: unknown;
    minHeight?: unknown;
    multiInstance?: unknown;
  };

  if (typeof definition.entry !== 'string') {
    throw new Error(`Panel contribution "${pluginName}.${panelName}" must be an object with an entry field`);
  }

  return {
    modulePath: definition.entry,
    constraints: {
      title: typeof definition.title === 'string' ? definition.title : undefined,
      titleKey: typeof definition.titleKey === 'string' ? definition.titleKey : undefined,
      width: typeof definition.width === 'number' ? definition.width : undefined,
      height: typeof definition.height === 'number' ? definition.height : undefined,
      minWidth: typeof definition.minWidth === 'number' ? definition.minWidth : undefined,
      minHeight: typeof definition.minHeight === 'number' ? definition.minHeight : undefined,
      multiInstance: typeof definition.multiInstance === 'boolean' ? definition.multiInstance : undefined,
    },
  };
}

export function load(ed: any) {
  runtime = ed;
}

export function attach(pluginName: string, contribute: any) {
  const panels = contribute?.panel;
  if (!panels) return;

  detach(pluginName);

  const info = runtime.plugin.getInfo(pluginName);
  if (!info) {
    throw new Error(`Plugin "${pluginName}" info not found while registering panels`);
  }

  const names: string[] = [];
  for (const [panelName, panelContribution] of Object.entries(panels)) {
    const normalized = normalizePanelContribution(pluginName, panelName, panelContribution);
    const fullName = `${pluginName}.${panelName}`;
    const absPath = path.resolve(info.path, normalized.modulePath);
    runtime.panel.register(fullName, absPath, normalized.constraints);
    names.push(fullName);
  }
  registered.set(pluginName, names);
}

export function detach(pluginName: string) {
  const names = registered.get(pluginName);
  if (names) {
    for (const name of names) {
      try {
        runtime.panel.unregister(name);
      } catch {
        // may have been unregistered externally
      }
    }
    registered.delete(pluginName);
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
