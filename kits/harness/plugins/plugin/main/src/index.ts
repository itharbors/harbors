declare const editor: any;

let runtime: any;

function resolvePluginPath(target: string): string {
  const info = runtime.plugin.getInfo(target);
  if (!info) throw new Error(`Plugin "${target}" is not registered`);
  return info.path;
}

function assertOwnNonBuiltin(target: string): void {
  const info = runtime.plugin.getInfo(target);
  if (!info) throw new Error(`Plugin "${target}" is not registered`);
  if (info.kind === "builtin") {
    throw new Error(`Cannot operate on builtin plugin "${info.name}"`);
  }
  const currentKit = runtime.kit.getCurrent();
  if (
    !currentKit ||
    info.source?.scope !== "kit" ||
    info.source?.kitId !== currentKit.name
  ) {
    throw new Error(`Plugin "${info.name}" does not belong to the current kit`);
  }
}

function toError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type PluginSource = "builtin" | "kit" | "external";

const SOURCE_ORDER: Record<PluginSource, number> = {
  builtin: 0,
  kit: 1,
  external: 2,
};

const SOURCE_LABEL: Record<PluginSource, string> = {
  builtin: "内置",
  kit: "自有",
  external: "外部",
};

function resolveSource(info: any, kitPlugins: Set<unknown>): PluginSource {
  if (info.kind === "builtin") return "builtin";
  return kitPlugins.has(info.name) ? "kit" : "external";
}

editor.plugin.define({
  lifecycle: { load(context: any) { runtime = context; } },
  methods: {
    getPluginSummary() {
      const currentKit = runtime.kit.getCurrent();
      const kitPlugins = new Set<string>(currentKit?.plugins ?? []);
      const loadedNames = new Set(runtime.plugin.listLoaded());
      const registeredPaths = runtime.plugin.listRegistered();
      const seen = new Set<string>();
      const plugins: any[] = [];

      for (const name of loadedNames) {
        const info = runtime.plugin.getInfo(name);
        if (!info) continue;
        seen.add(info.path);
        const contribute = info.contribute ?? {};
        const source = resolveSource(info, kitPlugins);
        plugins.push({
          name,
          path: info.path,
          kind: info.kind,
          source,
          sourceLabel: SOURCE_LABEL[source],
          loaded: true,
          panelCount: Object.keys(contribute.panel ?? {}).length,
          requestCount: Object.keys(contribute.message?.request ?? {}).length,
          broadcastCount: Object.keys(contribute.message?.broadcast ?? {}).length,
        });
      }

      for (const pluginPath of registeredPaths) {
        if (seen.has(pluginPath)) continue;
        const info = runtime.plugin.getInfo(pluginPath);
        if (!info) continue;
        const contribute = info.contribute ?? {};
        const source = resolveSource(info, kitPlugins);
        plugins.push({
          name: info.name,
          path: info.path,
          kind: info.kind,
          source,
          sourceLabel: SOURCE_LABEL[source],
          loaded: false,
          panelCount: Object.keys(contribute.panel ?? {}).length,
          requestCount: Object.keys(contribute.message?.request ?? {}).length,
          broadcastCount: Object.keys(contribute.message?.broadcast ?? {}).length,
        });
      }

      // 分组排序：内置在前、自有其次、外部最后；组内按名称排序。
      plugins.sort((left, right) => {
        const orderDiff = SOURCE_ORDER[left.source as PluginSource] - SOURCE_ORDER[right.source as PluginSource];
        if (orderDiff !== 0) return orderDiff;
        return left.name.localeCompare(right.name);
      });
      return {
        activeKitName: currentKit?.name ?? null,
        loadedCount: plugins.filter((plugin) => plugin.loaded).length,
        plugins,
      };
    },

    async register(target: string) {
      try {
        const info = runtime.plugin.getInfo(target);
        if (info) {
          assertOwnNonBuiltin(target);
        }
        await runtime.plugin.register(target);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: toError(error) };
      }
    },

    async unregister(target: string) {
      try {
        assertOwnNonBuiltin(target);
        await runtime.plugin.unregister(resolvePluginPath(target));
        return { ok: true };
      } catch (error) {
        return { ok: false, error: toError(error) };
      }
    },

    async load(target: string) {
      try {
        assertOwnNonBuiltin(target);
        await runtime.plugin.load(resolvePluginPath(target));
        return { ok: true };
      } catch (error) {
        return { ok: false, error: toError(error) };
      }
    },

    async unload(target: string) {
      try {
        assertOwnNonBuiltin(target);
        await runtime.plugin.unload(resolvePluginPath(target));
        return { ok: true };
      } catch (error) {
        return { ok: false, error: toError(error) };
      }
    },

    async restart(target: string) {
      try {
        assertOwnNonBuiltin(target);
        const path = resolvePluginPath(target);
        await runtime.plugin.unload(path);
        await runtime.plugin.load(path);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: toError(error) };
      }
    },
  },
});
