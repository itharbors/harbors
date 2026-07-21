import type {
  ContributeData,
  PluginAssetsManifest,
  PluginInfo,
  PluginKind,
  PluginModule as LoadedPluginModule,
} from './types';
import type { PluginRuntime, PluginRuntimeHost } from '../../editor/types';
import { PluginStatus } from './types';
import { Plugin } from './plugin';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withPluginDefinitionLock } from './load-lock';

interface PackageJson {
  name?: string;
  main?: string;
  'ce-editor'?: {
    assets?: PluginAssetsManifest;
    contribute?: ContributeData;
  };
}

function isDistJavaScriptEntry(value: string): boolean {
  return /(^|\/)dist\/.+\.(m?js|cjs)$/u.test(value);
}

function isDistPanelEntry(value: string): boolean {
  return /(^|\/)dist\/index\.html$/u.test(value);
}

function assertDistRuntimePaths(pkg: PackageJson, pluginName: string): void {
  if (!pkg.main || !isDistJavaScriptEntry(pkg.main)) {
    throw new Error(`Plugin "${pluginName}" package.json main must point to a dist JavaScript entry`);
  }
}

function resolveDeclaredMain(pluginRoot: string, pkg: PackageJson, pluginName: string): string {
  assertDistRuntimePaths(pkg, pluginName);

  const entryPath = path.resolve(pluginRoot, pkg.main!);
  const root = path.resolve(pluginRoot);
  if (entryPath === root || !entryPath.startsWith(root + path.sep)) {
    throw new Error(`Plugin "${pluginName}" package.json main must stay inside the plugin directory`);
  }
  if (!existsSync(entryPath) || !statSync(entryPath).isFile()) {
    throw new Error(`Plugin "${pluginName}" package.json main file does not exist`);
  }
  return entryPath;
}

function assertPanelContributions(pluginRoot: string, contribute: ContributeData | undefined, pluginName: string): void {
  const panel = contribute?.panel;
  if (!panel) return;

  const root = path.resolve(pluginRoot);
  for (const [panelName, definition] of Object.entries(panel)) {
    if (!definition || typeof definition !== 'object' || typeof definition.entry !== 'string' || !definition.entry) {
      throw new Error(`Plugin "${pluginName}" panel contribution "${panelName}" must be an object with an entry field`);
    }
    if (!isDistPanelEntry(definition.entry)) {
      throw new Error(`Plugin "${pluginName}" panel contribution "${panelName}" entry must point to a dist index.html file`);
    }
    const entryPath = path.resolve(pluginRoot, definition.entry);
    if (entryPath === root || !entryPath.startsWith(root + path.sep)) {
      throw new Error(`Plugin "${pluginName}" panel contribution "${panelName}" entry must stay inside the plugin directory`);
    }
    if (!existsSync(entryPath) || !statSync(entryPath).isFile()) {
      throw new Error(`Plugin "${pluginName}" panel contribution "${panelName}" entry file does not exist`);
    }
  }
}

let importNonce = 0;
const MESSAGE_OWNER = '@itharbors/message';
const MENU_OWNER = '@itharbors/menu';
const PANEL_OWNER = '@itharbors/panel';

function resolveLoadEntryPath(pluginRoot: string, entry: string): string {
  const entryPath = path.resolve(pluginRoot, entry);
  const root = path.resolve(pluginRoot);
  if (entryPath !== root && !entryPath.startsWith(root + path.sep)) {
    throw new Error(`Plugin at ${pluginRoot} has an out-of-bounds main entry`);
  }
  return entryPath;
}

export class PluginModule {
  private pathMap = new Map<string, Plugin>();
  private nameMap = new Map<string, Plugin>();

  async register(pluginPath: string, options: { kind: PluginKind } = { kind: 'external' }): Promise<void> {
    const absPath = path.resolve(pluginPath);
    if (this.pathMap.has(absPath)) return;

    const pkgPath = path.join(absPath, 'package.json');
    let pkg: PackageJson;
    try {
      pkg = JSON.parse(await readFile(pkgPath, 'utf-8')) as PackageJson;
    } catch {
      throw new Error(`Invalid plugin: no package.json found at ${absPath}`);
    }

    if (!pkg.name) {
      throw new Error(`Plugin at ${absPath} missing package name`);
    }
    if (!pkg['ce-editor']) {
      throw new Error(`Plugin at ${absPath} missing "ce-editor" field in package.json`);
    }

    resolveDeclaredMain(absPath, pkg, pkg.name);
    const contribute = pkg['ce-editor'].contribute;
    assertPanelContributions(absPath, contribute, pkg.name);
    const assets = pkg['ce-editor'].assets;
    const info: PluginInfo = {
      name: pkg.name,
      path: absPath,
      kind: options.kind,
      entry: pkg.main!,
      assets,
      contribute,
    };

    this.pathMap.set(absPath, new Plugin(info));
  }

  async load(pluginPath: string, editor?: PluginRuntimeHost): Promise<void> {
    const absPath = path.resolve(pluginPath);
    const registeredPlugin = this.pathMap.get(absPath);
    if (!registeredPlugin) {
      throw new Error(`Plugin at ${absPath} is not registered`);
    }

    const existing = this.nameMap.get(registeredPlugin.name);
    if (existing?.path === absPath && existing.status === PluginStatus.Running) return;
    if (existing) {
      await this.unload(existing.path);
    }

    const plugin = new Plugin({
      ...registeredPlugin.info,
      contribute: registeredPlugin.info.contribute
        ? JSON.parse(JSON.stringify(registeredPlugin.info.contribute)) as ContributeData
        : undefined,
    });
    plugin.status = PluginStatus.Loading;
    const entryPath = resolveLoadEntryPath(absPath, registeredPlugin.info.entry);

    let definition: LoadedPluginModule['definition'];
    const runtimeEditor = editor
      ? createPluginRuntime(editor, registeredPlugin.name)
      : undefined;

    if (runtimeEditor) {
      runtimeEditor.plugin.define = (nextDefinition) => {
        if (definition) {
          throw new Error(`Plugin "${registeredPlugin.name}" called editor.plugin.define() more than once`);
        }
        definition = nextDefinition;
      };
    }

    try {
      await withPluginDefinitionLock(async () => {
        const globalScope = globalThis as typeof globalThis & { editor?: PluginRuntime };
        const previousEditor = globalScope.editor;
        if (runtimeEditor) {
          globalScope.editor = runtimeEditor;
        }

        try {
          importNonce += 1;
          await import(pathToFileURL(entryPath).href + `?t=${Date.now()}-${importNonce}`);
        } finally {
          if (previousEditor === undefined) {
            delete globalScope.editor;
          } else {
            globalScope.editor = previousEditor;
          }
        }
      });
    } catch (error) {
      plugin.status = PluginStatus.Idle;
      throw error;
    }

    if (!definition) {
      plugin.status = PluginStatus.Idle;
      throw new Error(`Plugin "${registeredPlugin.name}" did not call editor.plugin.define()`);
    }

    plugin.instance = {
      definition,
      methods: definition.methods ?? {},
    };
    plugin.status = PluginStatus.Running;
    this.nameMap.set(plugin.name, plugin);

    try {
      if (definition.lifecycle?.load) {
        await definition.lifecycle.load(runtimeEditor as PluginRuntime);
      }

      for (const otherPlugin of this.nameMap.values()) {
        if (otherPlugin.name === plugin.name) continue;
        if (otherPlugin.instance?.definition?.lifecycle?.attach && plugin.contribute) {
          await otherPlugin.instance.definition.lifecycle.attach(plugin.name, plugin.contribute);
        }
        if (definition.lifecycle?.attach && otherPlugin.contribute) {
          await definition.lifecycle.attach(otherPlugin.name, otherPlugin.contribute);
        }
      }
    } catch (loadError) {
      try {
        await this.unload(absPath);
      } catch (cleanupError) {
        throw new AggregateError(
          [loadError, cleanupError],
          `Plugin "${plugin.name}" load and cleanup failed`,
        );
      }
      throw loadError;
    }
  }

  async unload(pluginPath: string): Promise<void> {
    const absPath = path.resolve(pluginPath);
    const plugin = Array.from(this.nameMap.values()).find((candidate) => candidate.path === absPath);
    if (!plugin || plugin.status !== PluginStatus.Running) return;

    plugin.status = PluginStatus.Unloading;
    const errors: unknown[] = [];

    try {
      if (plugin.instance?.definition?.lifecycle?.unload) {
        await plugin.instance.definition.lifecycle.unload();
      }
    } catch (error) {
      errors.push(error);
    }

    for (const otherPlugin of this.nameMap.values()) {
      if (otherPlugin.name !== plugin.name && otherPlugin.instance?.definition?.lifecycle?.detach) {
        try {
          await otherPlugin.instance.definition.lifecycle.detach(plugin.name);
        } catch (error) {
          errors.push(error);
        }
      }
    }

    this.nameMap.delete(plugin.name);
    plugin.status = PluginStatus.Idle;
    plugin.instance = null;

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, `Plugin "${plugin.name}" cleanup failed`);
    }
  }

  unregister(pluginPath: string): void {
    const absPath = path.resolve(pluginPath);
    const plugin = this.pathMap.get(absPath);
    if (!plugin) return;
    if (this.nameMap.get(plugin.name)?.path === absPath) {
      throw new Error(`Plugin "${plugin.name}" must be unloaded before unregistering`);
    }
    this.pathMap.delete(absPath);
  }

  getInfo(name: string): PluginInfo | undefined {
    const loaded = this.nameMap.get(name);
    if (loaded) return loaded.info;
    const byPath = this.pathMap.get(path.resolve(name));
    if (byPath) return byPath.info;
    for (const plugin of this.pathMap.values()) {
      if (plugin.name === name) return plugin.info;
    }
    return undefined;
  }

  listLoaded(): string[] {
    return Array.from(this.nameMap.keys());
  }

  listRegistered(): string[] {
    return Array.from(this.pathMap.keys());
  }

  callPlugin(name: string, method: string, ...args: unknown[]): unknown {
    const plugin = this.nameMap.get(name);
    if (!plugin?.instance) {
      throw new Error(`Plugin "${name}" is not loaded`);
    }

    const fn = plugin.instance.methods?.[method];
    if (typeof fn !== 'function') {
      const available = Object.keys(plugin.instance.methods ?? {});
      throw new Error(`Plugin "${name}" has no method "${method}". Available: ${available.join(', ')}`);
    }

    return fn(...args);
  }
}

function createPluginRuntime(
  editor: PluginRuntimeHost,
  ownerName: string,
): PluginRuntime {
  const menu = editor.menu;
  return {
    ...editor,
    plugin: {
      define: editor.plugin.define,
      getInfo: editor.plugin.getInfo,
      listLoaded: editor.plugin.listLoaded,
      listRegistered: editor.plugin.listRegistered,
      callPlugin: editor.plugin.callPlugin,
    },
    panel: {
      register: (name, modulePath, constraints) =>
        editor.panel.register(
          name,
          modulePath,
          constraints,
          resolveOwner(inferPanelOwner(name) ?? ownerName, ownerName, PANEL_OWNER),
        ),
      unregister: editor.panel.unregister,
      getInfo: editor.panel.getInfo,
      getRegistration: editor.panel.getRegistration,
      list: editor.panel.list,
    },
    menu: {
      attach: (pluginName, contribute) =>
        menu.attach(resolveOwner(pluginName, ownerName, MENU_OWNER), contribute),
      detach: (pluginName) =>
        menu.detach(resolveOwner(pluginName, ownerName, MENU_OWNER)),
      setDefaults: (items) => {
        if (ownerName !== MENU_OWNER) {
          throw new Error(`Plugin "${ownerName}" cannot set default menu`);
        }
        return editor.menu.setDefaults(items);
      },
      clearDefaults: () => {
        if (ownerName !== MENU_OWNER) {
          throw new Error(`Plugin "${ownerName}" cannot clear default menu`);
        }
        return editor.menu.clearDefaults();
      },
      reset: () => menu.reset(),
      getState: () => menu.getState(),
    },
    message: {
      registerRequest: (pluginName, name, handler, location, methods) =>
        editor.message.registerRequest(resolveOwner(pluginName, ownerName, MESSAGE_OWNER), name, handler, location, methods),
      registerBroadcast: (pluginName, topic, handler, location, methods) =>
        editor.message.registerBroadcast(resolveOwner(pluginName, ownerName, MESSAGE_OWNER), topic, handler, location, methods),
      unregisterRequest: (pluginName, name) =>
        editor.message.unregisterRequest(resolveOwner(pluginName, ownerName, MESSAGE_OWNER), name),
      unregisterBroadcast: (pluginName, topic) =>
        editor.message.unregisterBroadcast(resolveOwner(pluginName, ownerName, MESSAGE_OWNER), topic),
      request: (pluginName, name, ...args) =>
        editor.message.request(pluginName, name, ...args),
      broadcast: (topic, ...args) =>
        editor.message.broadcast(topic, ...args),
    },
  };
}

function resolveOwner(requestedOwner: string, runtimeOwner: string, delegateOwner: string): string {
  if (!requestedOwner || requestedOwner === runtimeOwner) {
    return runtimeOwner;
  }
  if (runtimeOwner === delegateOwner) {
    return requestedOwner;
  }
  throw new Error(`Plugin "${runtimeOwner}" cannot register as "${requestedOwner}"`);
}

function inferPanelOwner(panelName: string): string | undefined {
  const separatorIndex = panelName.lastIndexOf('.');
  return separatorIndex > 0 ? panelName.slice(0, separatorIndex) : undefined;
}
