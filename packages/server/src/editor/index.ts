import type { Editor } from './types';
import type { MenuContributionNode, MenuPlatform, NormalizedMenuResult } from '../framework/menu/types';
import { ConfigModule } from '../framework/config';
import type { ConfigLayerStore } from '../framework/config';
import { I18nModule } from '../framework/i18n/index';
import type { KitDescriptor, KitLayoutConfig, KitLayoutInputConfig } from '../framework/kit/types';
import type { PanelConstraints } from '../framework/panel/types';
import { KitModule, normalizeKitLayoutConfig } from '../framework/kit/index';
import { MenuModule } from '../framework/menu/index';
import { MessageModule } from '../framework/message/index';
import { PanelModule } from '../framework/panel/index';
import { PluginModule } from '../framework/plugin/index';
import { WindowManager } from '../framework/window/index';
import type { LayoutNode, WindowDescriptor } from '../framework/window/types';
import type { AssemblyConfig } from '../assembly/config';
import type { PluginResolveContext } from '../plugin/resolver';
import path from 'node:path';
import fs from 'node:fs';

const BUILTIN_PLUGINS = [
  '@itharbors/panel',
  '@itharbors/message',
  '@itharbors/menu',
  '@itharbors/config',
];

const sharedConfigStore: ConfigLayerStore = new Map();

interface KitPackageJson {
  name?: string;
  label?: string;
  icon?: string;
  'ce-editor'?: {
    kit?: {
      layouts?: Record<string, string>;
      theme?: Record<`--ce-${string}`, string>;
      plugin?: string[];
      windowEntries?: {
        main?: unknown;
        secondary?: unknown;
      };
    };
  };
}

interface ActiveExternalPlugin {
  path: string;
  name: string;
}

interface CreateEditorOptions {
  assembly: AssemblyConfig;
  dispatchBrowserRequest?: (panelKey: string, method: string, args: unknown[]) => Promise<unknown>;
  dispatchPanelBroadcast?: (panelKey: string, method: string, args: unknown[]) => void;
  onLayoutChanged?: (sessionId: string, window: WindowDescriptor) => void;
  onMenuChanged?: (sessionId: string, state: NormalizedMenuResult) => void;
  initialLocale?: string;
  platform?: MenuPlatform;
}

export function createEditor(sessionId: string, options: CreateEditorOptions): Editor {
  const assembly = options.assembly;
  const plugin = new PluginModule();
  const panel = new PanelModule();
  const config = new ConfigModule({
    sharedStore: sharedConfigStore,
    editorStore: new Map(),
  });
  const i18n = new I18nModule({
    defaultLocale: 'zh-CN',
    initialLocale: options.initialLocale ?? 'zh-CN',
  });
  const menu = new MenuModule({
    t: (key) => i18n.t(key),
    subscribe: (listener) => i18n.subscribe(listener),
    platform: options.platform,
    onChange: (state) => options.onMenuChanged?.(sessionId, state),
  });
  const runtimeMenu = {
    attach(pluginName: string, contribute: Parameters<MenuModule['attach']>[1]) {
      return menu.attach(pluginName, contribute);
    },
    detach(pluginName: string) {
      return menu.detach(pluginName);
    },
    setDefaults(items: MenuContributionNode[]) {
      return menu.setDefaults('@itharbors/menu', items);
    },
    clearDefaults() {
      return menu.clearDefaults('@itharbors/menu');
    },
    reset() {
      return menu.reset();
    },
    getState() {
      return menu.getState();
    },
    trigger(menuId: string) {
      return menu.trigger(menuId, {
        request: (pluginName, messageName) => editor.message.request(pluginName, messageName),
        triggerRole: async () => undefined,
      });
    },
  };
  const message = new MessageModule({
    dispatchPanelRequest: (panelKey, method, args) => panel.dispatch(panelKey, method, args),
    dispatchBrowserRequest: options.dispatchBrowserRequest,
    dispatchPanelBroadcast: (pluginName, _topic, method, args) => {
      for (const descriptor of panel.list()) {
        if (!descriptor.name.startsWith(`${pluginName}.`)) continue;
        options.dispatchPanelBroadcast?.(descriptor.name, method, args);
      }
    },
  });
  const kit = new KitModule();
  let windowManager: WindowManager | null = null;
  let corePluginsLoaded: Promise<void> | undefined;
  let activeExternalPlugins: ActiveExternalPlugin[] = [];
  let usable = true;
  let disposePromise: Promise<void> | undefined;

  function assertUsable(): void {
    if (!usable) {
      throw new Error('Editor is unavailable');
    }
  }

  async function disposeModules(): Promise<void> {
    const errors: unknown[] = [];
    const loadedPlugins = plugin.listLoaded().flatMap((name) => {
      const info = plugin.getInfo(name);
      return info ? [{ name: info.name, path: info.path }] : [];
    });

    try {
      await unloadExternalPlugins(loadedPlugins);
    } catch (error) {
      errors.push(error);
    }
    activeExternalPlugins = [];
    corePluginsLoaded = undefined;

    for (const destroy of [
      () => menu.destroy(),
      () => message.destroy(),
      () => panel.destroy(),
      () => i18n.destroy(),
      () => config.destroy(),
      () => kit.reset(),
      () => windowManager?.clear(),
    ]) {
      try {
        destroy();
      } catch (error) {
        errors.push(error);
      }
    }
    windowManager = null;

    if (errors.length > 0) {
      throw new AggregateError(errors, `Editor "${sessionId}" disposal failed`);
    }
  }

  function dispose(): Promise<void> {
    if (disposePromise) return disposePromise;
    usable = false;
    disposePromise = disposeModules();
    return disposePromise;
  }

  function pluginResolveContext(activeKitPluginsDir: string | null = null): PluginResolveContext {
    return {
      builtinPluginsDir: assembly.builtinPluginsDir,
      pluginsDir: assembly.pluginsDir,
      activeKitPluginsDir,
    };
  }

  async function ensureCorePluginsLoaded(): Promise<void> {
    if (corePluginsLoaded) return corePluginsLoaded;

    corePluginsLoaded = (async () => {
      const { resolvePlugin } = await import('../plugin/resolver');
      const loaded: string[] = [];
      try {
        for (const name of BUILTIN_PLUGINS) {
          const pluginPath = await resolvePlugin(name, pluginResolveContext());
          await plugin.register(pluginPath, { kind: 'builtin' });
          await plugin.load(pluginPath, {
            ...editor,
            menu: runtimeMenu,
          });
          loaded.push(pluginPath);
        }
      } catch (err) {
        for (const p of loaded) {
          try { await plugin.unload(p); } catch { /* best effort */ }
        }
        corePluginsLoaded = undefined;
        throw err;
      }
    })();

    await corePluginsLoaded;
    return corePluginsLoaded;
  }

  async function resolveAndReadKit(kitNameOrPath: string): Promise<{ descriptor: KitDescriptor; kitPath: string }> {
    const { resolveKit } = await import('../plugin/resolver');
    const kitPath = await resolveKit(kitNameOrPath, {
      builtinKitsDir: assembly.builtinKitsDir,
      kitsDir: assembly.kitsDir,
    });
    const pkg = JSON.parse(fs.readFileSync(path.join(kitPath, 'package.json'), 'utf-8')) as KitPackageJson;
    if (!pkg.name || !pkg['ce-editor']?.kit) {
      throw new Error(`Invalid kit at ${kitPath}: missing package name or ce-editor.kit`);
    }

    const layoutMap = pkg['ce-editor'].kit.layouts;
    if (!layoutMap || typeof layoutMap !== 'object' || !layoutMap.default) {
      throw new Error(`Kit "${pkg.name}" missing ce-editor.kit.layouts with a "default" key`);
    }

    const windowEntries = pkg['ce-editor'].kit.windowEntries;
    if (!isNonEmptyString(windowEntries?.main) || !isNonEmptyString(windowEntries.secondary)) {
      throw new Error(`Kit "${pkg.name}" must define ce-editor.kit.windowEntries.main and ce-editor.kit.windowEntries.secondary as strings`);
    }
    const normalizedWindowEntries = {
      main: windowEntries.main,
      secondary: windowEntries.secondary,
    };

    const layouts: Record<string, KitLayoutConfig> = {};
    for (const [name, layoutFile] of Object.entries(layoutMap)) {
      if (typeof layoutFile !== 'string') {
        throw new Error(`Kit "${pkg.name}" layout "${name}" must be a string path`);
      }
      const layoutInput = JSON.parse(
        fs.readFileSync(path.resolve(kitPath, layoutFile), 'utf-8'),
      ) as KitLayoutInputConfig;
      layouts[name] = normalizeKitLayoutConfig(layoutInput, normalizedWindowEntries);
    }

    const plugins = pkg['ce-editor'].kit.plugin ?? [];

    const descriptor: KitDescriptor = {
      name: pkg.name,
      label: pkg.label,
      icon: pkg.icon,
      theme: pkg['ce-editor'].kit.theme,
      plugins,
      layouts,
      windowEntries: normalizedWindowEntries,
    };

    return { descriptor, kitPath };
  }

  async function unloadExternalPlugins(pluginsToUnload: ActiveExternalPlugin[]): Promise<void> {
    const errors: unknown[] = [];
    for (const externalPlugin of [...pluginsToUnload].reverse()) {
      try {
        await plugin.unload(externalPlugin.path);
      } catch (error) {
        errors.push(error);
      } finally {
        panel.clearOwner(externalPlugin.name);
        message.clearOwner(externalPlugin.name);
        menu.detach(externalPlugin.name);
      }
    }

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, 'External plugin cleanup failed');
    }
  }

  async function unloadActiveExternalPlugins(): Promise<void> {
    const pluginsToUnload = [...activeExternalPlugins];
    try {
      await unloadExternalPlugins(pluginsToUnload);
    } finally {
      activeExternalPlugins = [];
    }
  }

  const cleanupLoadedExternalPlugins = unloadExternalPlugins;

  async function loadExternalPlugin(pluginPath: string, pluginName: string): Promise<ActiveExternalPlugin> {
    const externalPlugin = { path: pluginPath, name: pluginName };
    try {
      await plugin.load(pluginPath, {
        ...editor,
        menu: runtimeMenu,
      });
      return externalPlugin;
    } catch (loadError) {
      try {
        await cleanupLoadedExternalPlugins([externalPlugin]);
      } catch (cleanupError) {
        throw new AggregateError(
          [loadError, cleanupError],
          `Plugin "${pluginName}" load and owner cleanup failed`,
        );
      }
      throw loadError;
    }
  }

  async function restoreExternalPlugins(previousPlugins: ActiveExternalPlugin[]): Promise<void> {
    const restoredPlugins: ActiveExternalPlugin[] = [];
    try {
      for (const previousPlugin of previousPlugins) {
        restoredPlugins.push(await loadExternalPlugin(previousPlugin.path, previousPlugin.name));
      }
      activeExternalPlugins = restoredPlugins;
    } catch (restoreError) {
      activeExternalPlugins = [];
      try {
        await cleanupLoadedExternalPlugins(restoredPlugins);
      } catch (cleanupError) {
        throw new AggregateError(
          [restoreError, cleanupError],
          'Previous Kit plugin restore and cleanup failed',
        );
      }
      throw restoreError;
    }
  }

  async function loadKit(kitNameOrPath: string = assembly.defaultKit): Promise<KitDescriptor> {
    assertUsable();
    await ensureCorePluginsLoaded();

    const { resolvePlugin } = await import('../plugin/resolver');
    const { descriptor, kitPath } = await resolveAndReadKit(kitNameOrPath);
    const preparedPlugins: ActiveExternalPlugin[] = [];
    for (const pluginName of descriptor.plugins) {
      const pluginPath = await resolvePlugin(pluginName, pluginResolveContext(path.join(kitPath, 'plugins')));
      await plugin.register(pluginPath, { kind: 'external' });
      preparedPlugins.push({ path: pluginPath, name: pluginName });
    }
    const previousExternalPlugins = [...activeExternalPlugins];
    const loadedPlugins: ActiveExternalPlugin[] = [];
    const nextWindowManager = new WindowManager({
      defaultWindows: descriptor.layouts.default.windows,
      secondaryEntry: descriptor.windowEntries.secondary,
    });

    try {
      await unloadActiveExternalPlugins();
      for (const preparedPlugin of preparedPlugins) {
        loadedPlugins.push(await loadExternalPlugin(preparedPlugin.path, preparedPlugin.name));
      }
    } catch (switchError) {
      const rollbackErrors: unknown[] = [];
      try {
        await cleanupLoadedExternalPlugins(loadedPlugins);
      } catch (error) {
        rollbackErrors.push(error);
      }
      try {
        await cleanupLoadedExternalPlugins(previousExternalPlugins);
      } catch (error) {
        rollbackErrors.push(error);
      }

      if (previousExternalPlugins.length > 0) {
        try {
          await restoreExternalPlugins(previousExternalPlugins);
        } catch (restoreError) {
          rollbackErrors.push(restoreError);
          usable = false;
        }
      }

      if (!usable) {
        throw new AggregateError(
          [switchError, ...rollbackErrors],
          'Kit switch and rollback failed',
        );
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [switchError, ...rollbackErrors],
          'Kit switch failed and cleanup reported errors',
        );
      }
      throw switchError;
    }

    activeExternalPlugins = loadedPlugins;
    kit.register(descriptor);
    kit.switchKit(descriptor.name);
    windowManager = nextWindowManager;
    return descriptor;
  }

  function requireWindowManager(): WindowManager {
    if (!windowManager) {
      throw new Error('Window manager is unavailable before a kit is loaded');
    }
    return windowManager;
  }

  function applyLayout(input: string | LayoutNode): void {
    const currentKit = kit.getCurrent();
    if (!currentKit) {
      throw new Error('No active kit');
    }

    let targetLayout: LayoutNode;
    if (typeof input === 'string') {
      const layoutConfig = currentKit.layouts[input];
      if (!layoutConfig) {
        throw new Error(`Layout "${input}" not found in kit "${currentKit.name}"`);
      }
      const mainWindow = layoutConfig.windows.find((w) => w.kind === 'main');
      if (!mainWindow) {
        throw new Error(`Layout "${input}" has no main window`);
      }
      targetLayout = mainWindow.layout;
    } else {
      targetLayout = input;
    }

    const wm = requireWindowManager();
    const mainWindow = wm.list().find((w) => w.kind === 'main');
    if (!mainWindow) {
      throw new Error('No main window found');
    }

    const updatedWindow = wm.rearrange(mainWindow.id, targetLayout);
    options.onLayoutChanged?.(sessionId, updatedWindow);
  }

  const editor: Editor = {
    sessionId,
    isUsable: () => usable,
    dispose,
    config,
    i18n,
    plugin: {
      define: () => {
        throw new Error('editor.plugin.define() is only available while loading a plugin entry file');
      },
      register: (pluginPath: string) => {
        assertUsable();
        return plugin.register(pluginPath);
      },
      load: async (pluginPath: string) => {
        assertUsable();
        await ensureCorePluginsLoaded();
        const info = plugin.getInfo(pluginPath);
        try {
          await plugin.load(pluginPath, {
            ...editor,
            menu: runtimeMenu,
          });
        } catch (err) {
          if (info) {
            panel.clearOwner(info.name);
            message.clearOwner(info.name);
            menu.detach(info.name);
          }
          throw err;
        }
      },
      unload: (pluginPath: string) => {
        assertUsable();
        return plugin.unload(plugin.getInfo(pluginPath)?.path ?? pluginPath);
      },
      unregister: (pluginPath: string) => {
        assertUsable();
        return plugin.unregister(pluginPath);
      },
      getInfo: (name: string) => plugin.getInfo(name),
      listLoaded: () => plugin.listLoaded(),
      listRegistered: () => plugin.listRegistered(),
      callPlugin: (name: string, method: string, ...args: unknown[]) => plugin.callPlugin(name, method, ...args),
    },
    panel: {
      define: () => {
        throw new Error('editor.panel.define() is only available inside a panel asset iframe');
      },
      register: (name: string, modulePath: string, constraints?: PanelConstraints, owner?: string) =>
        panel.register(name, modulePath, constraints, owner),
      unregister: (name: string) => panel.unregister(name),
      getInfo: (name: string) => panel.getInfo(name),
      getRegistration: (name: string) => panel.getRegistration(name),
      list: () => panel.list(),
      focus: (name: string) => panel.focus(name),
    },
    message: {
      registerRequest: (pluginName, name, handler, location = 'server', methods = []) =>
        message.registerRequest(pluginName, name, handler, location, methods),
      registerBroadcast: (pluginName, topic, handler, location = 'server', methods = []) =>
        message.registerBroadcast(pluginName, topic, handler, location, methods),
      unregisterRequest: (pluginName, name) => message.unregisterRequest(pluginName, name),
      unregisterBroadcast: (pluginName, topic) => message.unregisterBroadcast(pluginName, topic),
      queryRequest: (pluginName, name) => message.queryRequest(pluginName, name),
      queryBroadcast: (topic) => message.queryBroadcast(topic),
      request: (pluginName: string, name: string, ...args: unknown[]) => message.request(pluginName, name, ...args),
      broadcast: (topic: string, ...args: unknown[]) => message.broadcast(topic, ...args),
    },
    kit: {
      load: (kitNameOrPath?: string) => loadKit(kitNameOrPath),
      register: (descriptor: KitDescriptor) => kit.register(descriptor),
      unregister: (name: string) => kit.unregister(name),
      list: () => kit.list(),
      get: (name: string) => kit.get(name),
      getCurrent: () => kit.getCurrent(),
      switchKit: (kitName: string) => loadKit(kitName).then(() => undefined),
      applyLayout: (input: string | LayoutNode) => applyLayout(input),
      get layouts() {
        return kit.listLayouts();
      },
    },
    menu: {
      getState: () => runtimeMenu.getState(),
      trigger: (menuId: string) => runtimeMenu.trigger(menuId),
    },
    window: {
      getSnapshot: () => requireWindowManager().getSnapshot(),
      openPanel: (panelName: string) => {
        const descriptor = panel.getInfo(panelName);
        return requireWindowManager().openPanel({
          panelName,
          layout: { type: 'leaf', panel: panelName },
          entry: kit.getCurrent()?.windowEntries.secondary ?? 'secondary.html',
          multiInstance: descriptor.multiInstance === true,
        });
      },
      markPanelInstanceFloating: (panelInstanceId: string) => {
        requireWindowManager().markFloating(panelInstanceId);
      },
      markWindowGroupOpened: (windowGroupId: string) => {
        requireWindowManager().markWindowGroupOpened(windowGroupId);
      },
      closeWindowGroup: (windowGroupId: string) => {
        requireWindowManager().closeWindowGroup(windowGroupId);
      },
      setPanelInstanceState: (panelInstanceId: string, state: 'open' | 'minimized') => {
        requireWindowManager().setPanelInstanceState(panelInstanceId, state);
      },
      closePanelInstance: (panelInstanceId: string) => {
        requireWindowManager().closePanelInstance(panelInstanceId);
      },
    },
  };

  return editor;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
