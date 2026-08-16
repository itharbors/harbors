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

editor.plugin.define({
  lifecycle: { load(context: any) { runtime = context; } },
  methods: {
    getPluginSummary() {
      const currentKit = runtime.kit.getCurrent();
      const kitPlugins = new Set(currentKit?.plugins ?? []);
      const loadedNames = new Set(runtime.plugin.listLoaded());
      const registeredPaths = runtime.plugin.listRegistered();
      const seen = new Set<string>();
      const plugins: any[] = [];

      for (const name of loadedNames) {
        const info = runtime.plugin.getInfo(name);
        if (!info) continue;
        seen.add(info.path);
        const contribute = info.contribute ?? {};
        plugins.push({
          name,
          path: info.path,
          kind: info.kind,
          source: info.kind === "builtin" ? "builtin" : kitPlugins.has(name) ? "kit" : "external",
          loaded: true,
          panelCount: Object.keys(contribute.panel ?? {}).length,
          requestCount: Object.keys(contribute.message?.request ?? {}).length,
        });
      }

      for (const pluginPath of registeredPaths) {
        if (seen.has(pluginPath)) continue;
        const info = runtime.plugin.getInfo(pluginPath);
        if (!info) continue;
        const contribute = info.contribute ?? {};
        plugins.push({
          name: info.name,
          path: info.path,
          kind: info.kind,
          source: info.kind === "builtin" ? "builtin" : kitPlugins.has(info.name) ? "kit" : "external",
          loaded: false,
          panelCount: Object.keys(contribute.panel ?? {}).length,
          requestCount: Object.keys(contribute.message?.request ?? {}).length,
        });
      }

      plugins.sort((left, right) => left.name.localeCompare(right.name));
      return { activeKitName: currentKit?.name ?? null, plugins };
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
