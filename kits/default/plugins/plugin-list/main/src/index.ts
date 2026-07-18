declare const editor: any;

let runtime;
let selectedPluginName;
const SELECTED_TOPIC = 'plugin.selected';

editor.plugin.define({
  lifecycle: {
    load(ctx) {
      runtime = ctx;
    },
  },
  methods: {
    openListPanel() {
      return runtime.window.openPanel('@ce/plugin-list.list');
    },
    getPlugins() {
      return getLoadedPlugins();
    },
    getPluginSummary() {
      const currentKit = runtime.kit.getCurrent();
      const plugins = getLoadedPlugins(currentKit);
      return {
        count: plugins.length,
        activeKitName: currentKit?.name ?? null,
        selectedPluginName: getSelectedPluginName(plugins),
        groups: summarizeGroups(plugins),
        plugins,
      };
    },
    getSelectedPlugin() {
      const currentKit = runtime.kit.getCurrent();
      const plugins = getLoadedPlugins(currentKit);
      return findPluginDetail(plugins, getSelectedPluginName(plugins));
    },
    selectPlugin(name) {
      const currentKit = runtime.kit.getCurrent();
      const plugins = getLoadedPlugins(currentKit);
      const detail = findPluginDetail(plugins, name);
      selectedPluginName = detail?.name;
      runtime.message.broadcast(SELECTED_TOPIC, detail);
      return detail;
    },
  },
});

function getLoadedPlugins(currentKit?) {
  const kitPluginNames = new Set(currentKit?.plugins ?? []);
  return runtime.plugin.listLoaded().map((name) => {
    const info = runtime.plugin.getInfo(name);
    const contribute = info?.contribute ?? {};
    return {
      name,
      source: getPluginSource(name, kitPluginNames),
      contribute,
      path: info?.path,
      panelCount: Object.keys(contribute.panel ?? {}).length,
      requestCount: Object.keys(contribute.message?.request ?? {}).length,
      broadcastCount: Object.keys(contribute.message?.broadcast ?? {}).length,
    };
  }).sort((left, right) => {
    const sourceOrder = compareSource(left.source, right.source);
    if (sourceOrder !== 0) return sourceOrder;
    return left.name.localeCompare(right.name);
  });
}

function getPluginSource(name, kitPluginNames) {
  const kind = runtime.plugin.getInfo(name)?.kind;
  if (kind === 'builtin') return 'builtin';
  if (kitPluginNames.has(name)) return 'kit';
  return 'external';
}

function compareSource(left, right) {
  const priority = {
    builtin: 0,
    kit: 1,
    external: 2,
  };
  return (priority[left] ?? 99) - (priority[right] ?? 99);
}

function getSelectedPluginName(plugins) {
  if (plugins.some((plugin) => plugin.name === selectedPluginName)) {
    return selectedPluginName;
  }
  return plugins[0]?.name;
}

function findPluginDetail(plugins, name) {
  return plugins.find((plugin) => plugin.name === name) ?? plugins[0] ?? null;
}

function summarizeGroups(plugins) {
  return plugins.reduce((groups, plugin) => {
    groups[plugin.source] = (groups[plugin.source] ?? 0) + 1;
    return groups;
  }, {
    builtin: 0,
    kit: 0,
    external: 0,
  });
}
