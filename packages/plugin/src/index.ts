import type {
  ContributeData,
  PluginAssetsManifest,
  PluginInfo,
  PluginKind,
  PluginSourceIdentity,
  PluginRegistration,
  PluginCapability,
  PluginModule as LoadedPluginModule,
} from './types.js';
import type {
  ApplicationPluginRuntime,
  ApplicationPluginRuntimeHost,
  PluginLoadOptions,
  PluginRuntime,
  PluginRuntimeHost,
  PluginConfig,
  PluginConfigBindingHost,
  PluginSessionIdentity,
} from './runtime.js';
import { PluginStatus } from './types.js';
import { Plugin } from './plugin.js';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withPluginDefinitionLock } from './load-lock.js';
import { createPluginPaths, createSessionPluginPaths, pluginStorageOwnerKey, type PluginPaths, type SessionPluginPaths } from './paths.js';
import { assertPluginMethodAccess } from './method-access.js';
import type { PluginCredentialVault } from './credentials.js';
import { parsePluginPackageManifest } from './manifest.js';
import { PluginDependencyError } from './dependencies.js';

export { Plugin } from './plugin.js';
export {
  createPluginPaths,
  createSessionPluginPaths,
  pluginStorageOwnerKey,
  PLUGIN_STORAGE_UNAVAILABLE,
  PluginStorageUnavailableError,
} from './paths.js';
export type {
  CreatePluginPathsOptions,
  PluginDirectoryHandle,
  PluginPathFileSystem,
  PluginPathRoots,
  PluginPaths,
  SessionPluginPaths,
} from './paths.js';
export { PluginStatus } from './types.js';
export type {
  CredentialCapabilitySnapshot,
  CredentialMode,
  CredentialProfile,
  PluginCredentialVault,
} from './credentials.js';
export * from './manifest.js';
export * from './dependencies.js';
export { assertPluginMethodAccess } from './method-access.js';
export type {
  ContributeData,
  PanelContribution,
  PluginAssetsManifest,
  PluginCapability,
  PluginDefinition,
  PluginInfo,
  PluginKind,
  PluginLifecycle,
  PluginMessageRoute,
  PluginMessageRouteDeclaration,
  PluginRequirements,
  PluginSourceIdentity,
  PluginRegistration,
} from './types.js';
export type {
  ApplicationHostMode,
  ApplicationPluginRuntime,
  ApplicationPluginRuntimeHost,
  MessageLocation,
  NotificationHostCapability,
  NotificationInput,
  NotificationRecord,
  NotificationSnapshot,
  PluginLoadOptions,
  PluginPathLoadConfiguration,
  PluginRuntime,
  PluginRuntimeHost,
  PluginConfig,
  PluginConfigBindingHost,
  PluginConfigChangeEvent,
  PluginConfigValue,
  PluginRuntimeMenuHost,
  PluginRuntimeMessageHost,
  PluginRuntimePanelHost,
  PluginRuntimePluginHost,
  PluginSessionIdentity,
} from './runtime.js';

function unavailablePluginConfig(): PluginConfig {
  const unavailable = (): never => {
    throw new Error('Plugin config host is unavailable');
  };
  return {
    get: unavailable,
    set: unavailable,
    delete: unavailable,
    subscribe: unavailable,
  };
}

function credentialOperationFailed(): Error & { readonly code: 'CREDENTIAL_OPERATION_FAILED' } {
  return Object.assign(new Error('Credential operation failed'), {
    code: 'CREDENTIAL_OPERATION_FAILED' as const,
  });
}

interface PackageJson {
  name?: string;
  main?: string;
  type?: string;
  'ce-editor'?: {
    assets?: PluginAssetsManifest;
    capabilities?: unknown;
    requires?: unknown;
    contribute?: ContributeData;
  };
}

interface PluginDefinitionBridge {
  readonly plugin: Readonly<{
    define(definition: import('./types.js').PluginDefinition): void;
  }>;
}

interface RegisteredPlugin {
  readonly path: string;
  readonly kind: PluginKind;
  readonly source: PluginSourceIdentity;
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
  const realRoot = realpathSync(root);
  const realEntryPath = realpathSync(entryPath);
  if (realEntryPath !== realRoot && !realEntryPath.startsWith(realRoot + path.sep)) {
    throw new Error(`Plugin "${pluginName}" package.json main must stay inside the plugin directory`);
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
    const realRoot = realpathSync(root);
    const realEntryPath = realpathSync(entryPath);
    if (realEntryPath !== realRoot && !realEntryPath.startsWith(realRoot + path.sep)) {
      throw new Error(`Plugin "${pluginName}" panel contribution "${panelName}" entry must stay inside the plugin directory`);
    }
  }
}

let importNonce = 0;
const MESSAGE_OWNER = 'message';
const MENU_OWNER = 'menu';
const PANEL_OWNER = 'panel';

function resolveLoadEntryPath(pluginRoot: string, entry: string): string {
  const entryPath = path.resolve(pluginRoot, entry);
  const root = path.resolve(pluginRoot);
  if (entryPath !== root && !entryPath.startsWith(root + path.sep)) {
    throw new Error(`Plugin at ${pluginRoot} has an out-of-bounds main entry`);
  }
  const realRoot = realpathSync(root);
  const realEntryPath = realpathSync(entryPath);
  if (realEntryPath !== realRoot && !realEntryPath.startsWith(realRoot + path.sep)) {
    throw new Error(`Plugin at ${pluginRoot} has an out-of-bounds main entry`);
  }
  return entryPath;
}

function clearPluginRequireCache(entryPath: string): void {
  const realEntryPath = requireResolveRealPath(entryPath);
  const entryDir = path.dirname(realEntryPath);
  const cache = createRequire(realEntryPath).cache;
  const childrenByParent = new Map<string, string[]>();

  for (const [filename, cachedModule] of Object.entries(cache)) {
    if (!cachedModule) continue;
    const parentFilename = cachedModule.parent?.filename;
    if (!parentFilename) continue;
    const children = childrenByParent.get(parentFilename) ?? [];
    children.push(filename);
    childrenByParent.set(parentFilename, children);
  }

  const visited = new Set<string>();
  const pending = [realEntryPath];
  const pluginModules = new Set<string>();
  while (pending.length > 0) {
    const filename = pending.pop()!;
    if (visited.has(filename)) continue;
    visited.add(filename);
    pluginModules.add(filename);

    const cachedModule = cache[filename];
    if (cachedModule) {
      for (const child of cachedModule.children) {
        pending.push(child.filename);
      }
    }
    // A failed entry is evicted from require.cache, but its successfully
    // loaded children retain a parent whose filename points at the entry.
    for (const child of childrenByParent.get(filename) ?? []) {
      pending.push(child);
    }
  }

  for (const filename of pluginModules) {
    let realFilename: string;
    try {
      realFilename = realpathSync(filename);
    } catch {
      continue;
    }
    const relative = path.relative(entryDir, realFilename);
    if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      continue;
    }
    // A plugin may live below a node_modules directory, so only exclude
    // node_modules segments below the entry directory itself.
    if (relative.split(path.sep).includes('node_modules')) continue;
    delete cache[filename];
  }
}

function requireResolveRealPath(entryPath: string): string {
  const require = createRequire(entryPath);
  const resolved = require.resolve(entryPath);
  return resolved;
}

export class PluginModule {
  private pathMap = new Map<string, RegisteredPlugin>();
  private nameMap = new Map<string, Plugin>();
  private credentialRevokers = new Map<string, () => Promise<void>>();
  private ownerClearers = new Map<string, () => Promise<void> | void>();
  private commonjsPaths = new Set<string>();
  private loadingPaths = new Set<string>();
  private pendingLifecyclePaths = new Map<string, number>();
  private lifecycleQueue: Promise<void> = Promise.resolve();

  async register(pluginPath: string, options: {
    kind: PluginKind;
    source?: PluginSourceIdentity;
  } = { kind: 'external' }): Promise<void> {
    const absPath = path.resolve(pluginPath);
    if (this.pathMap.has(absPath)) return;
    this.pathMap.set(absPath, {
      path: absPath,
      kind: options.kind,
      source: {
        ...(options.source ?? {
          scope: options.kind === 'builtin' ? 'framework' : 'unmanaged',
        }),
      },
    });
  }

  /** Read and validate the current manifest without executing the plugin entry. */
  async inspect(pluginPath: string): Promise<PluginInfo> {
    const absPath = path.resolve(pluginPath);
    const registration = this.pathMap.get(absPath);
    if (!registration) throw new Error(`Plugin at ${absPath} is not registered`);
    return this.readPluginInfo(absPath, registration);
  }

  private async readPluginInfo(absPath: string, registration: RegisteredPlugin): Promise<PluginInfo> {
    let pkg: PackageJson;
    try {
      pkg = JSON.parse(await readFile(path.join(absPath, 'package.json'), 'utf-8')) as PackageJson;
    } catch {
      throw new Error(`Invalid plugin: no package.json found at ${absPath}`);
    }
    return this.createPluginInfo(absPath, registration, pkg);
  }

  private createPluginInfo(absPath: string, registration: RegisteredPlugin, pkg: PackageJson): PluginInfo {
    const manifest = parsePluginPackageManifest(pkg);
    resolveDeclaredMain(absPath, { ...pkg, main: manifest.main }, manifest.name);
    const contribute = manifest.contribute as ContributeData;
    assertPanelContributions(absPath, contribute, manifest.name);
    const assets = manifest.assets.public.length > 0
      ? { public: [...manifest.assets.public] }
      : undefined;
    return {
      name: manifest.name,
      storageOwnerKey: pluginStorageOwnerKey(manifest.name),
      version: manifest.version,
      path: absPath,
      kind: registration.kind,
      source: { ...registration.source },
      entry: manifest.main,
      capabilities: [...manifest.capabilities],
      ...(manifest.requires.plugins.length > 0
        ? { requires: { plugins: [...manifest.requires.plugins] } }
        : {}),
      ...(assets ? { assets } : {}),
      ...(contribute ? { contribute } : {}),
    };
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleQueue;
    let resolveTail!: () => void;
    this.lifecycleQueue = new Promise<void>((resolve) => { resolveTail = resolve; });
    return previous.then(operation).finally(resolveTail) as Promise<T>;
  }

  async load(
    pluginPath: string,
    runtimeInput: PluginLoadOptions,
  ): Promise<void> {
    const absPath = path.resolve(pluginPath);
    const options = runtimeInput.scope === 'session'
      ? { ...runtimeInput, identity: Object.freeze({ ...runtimeInput.identity }) }
      : runtimeInput;
    if (options.scope === 'session') {
      pluginStorageOwnerKey(options.identity.userId);
      pluginStorageOwnerKey(options.identity.sessionId);
    }
    this.pendingLifecyclePaths.set(absPath, (this.pendingLifecyclePaths.get(absPath) ?? 0) + 1);
    return this.enqueueLifecycle(() => this.loadInternal(absPath, options))
      .finally(() => this.releasePendingLifecycle(absPath));
  }

  private async loadInternal(
    pluginPath: string,
    runtimeInput: PluginLoadOptions,
  ): Promise<void> {
    const absPath = path.resolve(pluginPath);
    const registration = this.pathMap.get(absPath);
    if (!registration) {
      throw new Error(`Plugin at ${absPath} is not registered`);
    }

    // Loading is the only implicit manifest read. Never reuse a registration snapshot.
    const loadedInfo = await this.readPluginInfo(absPath, registration);

    for (const dependency of loadedInfo.requires?.plugins ?? []) {
      if (dependency === loadedInfo.name) {
        throw new PluginDependencyError(
          'PLUGIN_DEPENDENCY_INVALID',
          `Plugin "${loadedInfo.name}" must not depend on itself`,
          { plugin: loadedInfo.name, dependency },
        );
      }
      const dependencyPlugin = this.nameMap.get(dependency);
      if (!dependencyPlugin || dependencyPlugin.status !== PluginStatus.Running) {
        throw new PluginDependencyError(
          'PLUGIN_NOT_RUNNING',
          `Plugin "${loadedInfo.name}" requires Plugin "${dependency}" to be Running`,
          { plugin: loadedInfo.name, dependency },
        );
      }
    }

    const existing = this.nameMap.get(loadedInfo.name);
    if (existing?.path === absPath && existing.status === PluginStatus.Running) return;
    if (existing) {
      await this.unloadInternal(existing.path);
    }

    const plugin = new Plugin({
      ...loadedInfo,
      contribute: loadedInfo.contribute
        ? JSON.parse(JSON.stringify(loadedInfo.contribute)) as ContributeData
        : undefined,
    });
    plugin.status = PluginStatus.Loading;
    const entryPath = resolveLoadEntryPath(absPath, loadedInfo.entry);
    if (loadedInfo.entry.endsWith('.js')) {
      let pkgType: string | undefined;
      try {
        pkgType = (JSON.parse(await readFile(path.join(absPath, 'package.json'), 'utf8')) as PackageJson).type;
      } catch { /* readPluginInfo already validated this file */ }
      if (pkgType !== 'module') this.commonjsPaths.add(absPath);
      else this.commonjsPaths.delete(absPath);
    }

    let definition: LoadedPluginModule['definition'];
    const runtimeOptions = runtimeInput;
    const runtimePaths = runtimeOptions.scope === 'session' ? await createSessionPluginPaths({
      roots: runtimeOptions.paths.roots,
      owner: loadedInfo.name,
      identity: runtimeOptions.identity,
    }) : await createPluginPaths({
      roots: runtimeOptions.paths.roots,
      owner: loadedInfo.name,
    });
    this.loadingPaths.add(absPath);
    let credentialLease: ReturnType<typeof createRevocableCredentialVault> | undefined;
    let lifecycleRuntime: PluginRuntime | ApplicationPluginRuntime | undefined;

    try {
      await withPluginDefinitionLock(async () => {
        const globalScope = globalThis as typeof globalThis & {
          editor?: PluginDefinitionBridge;
        };
        const previousEditorDescriptor = Object.getOwnPropertyDescriptor(globalScope, 'editor');
        if (previousEditorDescriptor && !previousEditorDescriptor.configurable) {
          throw new Error('Cannot safely install plugin definition bridge: globalThis.editor is non-configurable');
        }

        credentialLease = runtimeOptions.scope === 'session'
          && loadedInfo.capabilities?.includes('credentials')
          && runtimeOptions.credentials
          ? createRevocableCredentialVault(runtimeOptions.credentials)
          : undefined;
        lifecycleRuntime = runtimeOptions.scope === 'application'
          ? createApplicationPluginRuntime(runtimeOptions.host, loadedInfo, runtimePaths)
          : createPluginRuntime(
              runtimeOptions.host,
              loadedInfo,
              runtimePaths as SessionPluginPaths,
              runtimeOptions.identity,
              runtimeOptions.config,
              runtimeOptions.kitId,
              credentialLease?.facade,
            );
        Object.freeze(lifecycleRuntime);
        const definitionBridge = createPluginDefinitionBridge((nextDefinition) => {
          if (definition) {
            throw new Error(`Plugin "${loadedInfo.name}" called editor.plugin.define() more than once`);
          }
          definition = nextDefinition;
        });
        Object.defineProperty(globalScope, 'editor', {
          value: definitionBridge,
          writable: false,
          configurable: true,
          enumerable: previousEditorDescriptor?.enumerable ?? false,
        });

        try {
          if (entryPath.endsWith('.cjs')) {
            clearPluginRequireCache(entryPath);
            const cjsRequire = createRequire(entryPath);
            cjsRequire(entryPath);
          } else {
            if (this.commonjsPaths.has(absPath)) clearPluginRequireCache(entryPath);
            importNonce += 1;
            await import(pathToFileURL(entryPath).href + `?t=${Date.now()}-${importNonce}`);
          }
        } finally {
          if (previousEditorDescriptor) {
            Object.defineProperty(globalScope, 'editor', previousEditorDescriptor);
          } else {
            Reflect.deleteProperty(globalScope, 'editor');
          }
        }
      });
    } catch (error) {
      await credentialLease?.revokeAndDrain();
      plugin.status = PluginStatus.Idle;
      this.loadingPaths.delete(absPath);
      throw error;
    }

    if (!definition) {
      await credentialLease?.revokeAndDrain();
      plugin.status = PluginStatus.Idle;
      this.loadingPaths.delete(absPath);
      throw new Error(`Plugin "${loadedInfo.name}" did not call editor.plugin.define()`);
    }

    plugin.instance = {
      definition,
      methods: definition.methods ?? {},
    };
    this.nameMap.set(plugin.name, plugin);
    this.loadingPaths.delete(absPath);
    if (credentialLease) this.credentialRevokers.set(plugin.path, credentialLease.revokeAndDrain);
    if (runtimeOptions.scope === 'session' && runtimeOptions.host.clearOwner) {
      this.ownerClearers.set(plugin.path, () => runtimeOptions.host.clearOwner!(plugin.name));
    }

    try {
      if (definition.lifecycle?.load) {
        await definition.lifecycle.load(lifecycleRuntime!);
      }

      for (const otherPlugin of this.nameMap.values()) {
        if (otherPlugin.name === plugin.name) continue;
        if (otherPlugin.instance?.definition?.lifecycle?.attach && plugin.contribute) {
          await otherPlugin.instance.definition.lifecycle.attach(plugin.name, structuredClone(plugin.contribute));
        }
        if (definition.lifecycle?.attach && otherPlugin.contribute) {
          await definition.lifecycle.attach(otherPlugin.name, structuredClone(otherPlugin.contribute));
        }
      }
      plugin.status = PluginStatus.Running;
    } catch (loadError) {
      try {
        await this.unloadInternal(absPath);
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
    this.pendingLifecyclePaths.set(absPath, (this.pendingLifecyclePaths.get(absPath) ?? 0) + 1);
    return this.enqueueLifecycle(() => this.unloadInternal(absPath))
      .finally(() => this.releasePendingLifecycle(absPath));
  }

  private async unloadInternal(pluginPath: string): Promise<void> {
    const absPath = path.resolve(pluginPath);
    const plugin = Array.from(this.nameMap.values()).find((candidate) => candidate.path === absPath);
    if (!plugin || (plugin.status !== PluginStatus.Running && plugin.status !== PluginStatus.Loading)) return;

    const dependent = Array.from(this.nameMap.values()).find((candidate) => (
      candidate.name !== plugin.name
      && candidate.status === PluginStatus.Running
      && candidate.info.requires?.plugins.includes(plugin.name)
    ));
    if (dependent) {
      throw new PluginDependencyError(
        'PLUGIN_DEPENDENTS_RUNNING',
        `Plugin "${plugin.name}" cannot unload while dependent Plugin "${dependent.name}" is Running`,
        { plugin: plugin.name, dependency: dependent.name },
      );
    }

    plugin.status = PluginStatus.Unloading;
    const errors: unknown[] = [];

    try {
      await this.credentialRevokers.get(plugin.path)?.();
    } catch (error) {
      errors.push(error);
    }
    this.credentialRevokers.delete(plugin.path);

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

    try {
      await this.ownerClearers.get(plugin.path)?.();
    } catch (error) {
      errors.push(error);
    }
    this.ownerClearers.delete(plugin.path);

    // Drop entry-local CommonJS state as part of unload; the next load still
    // re-reads the manifest and re-detects the module format.
    if (this.commonjsPaths.has(plugin.path)) {
      try {
        clearPluginRequireCache(resolveLoadEntryPath(plugin.path, plugin.info.entry));
      } catch {
        // A removed entry is already uncached; do not hide the lifecycle result.
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
    const loaded = Array.from(this.nameMap.values()).find((candidate) => candidate.path === absPath);
    if (loaded || this.loadingPaths.has(absPath) || this.pendingLifecyclePaths.has(absPath)) {
      throw new Error(`Plugin "${loaded?.name ?? absPath}" must be unloaded before unregistering`);
    }
    this.pathMap.delete(absPath);
    this.commonjsPaths.delete(absPath);
  }

  getInfo(name: string): PluginInfo | undefined {
    const loaded = this.nameMap.get(name);
    if (loaded) return structuredClone(loaded.info);
    return undefined;
  }

  listLoaded(): string[] {
    return Array.from(this.nameMap.keys());
  }

  listRegistered(): string[] {
    return Array.from(this.pathMap.keys());
  }

  getRegistration(pluginPath: string): PluginRegistration | undefined {
    const registration = this.pathMap.get(path.resolve(pluginPath));
    return registration ? { ...registration, source: { ...registration.source } } : undefined;
  }

  private releasePendingLifecycle(absPath: string): void {
    const count = this.pendingLifecyclePaths.get(absPath) ?? 0;
    if (count <= 1) this.pendingLifecyclePaths.delete(absPath);
    else this.pendingLifecyclePaths.set(absPath, count - 1);
  }

  callPlugin(name: string, method: string, ...args: unknown[]): unknown {
    const plugin = this.nameMap.get(name);
    if (!plugin?.instance || plugin.status !== PluginStatus.Running) {
      throw new PluginDependencyError(
        'PLUGIN_NOT_RUNNING',
        `Plugin "${name}" is not Running`,
        { plugin: name },
      );
    }

    const fn = plugin.instance.methods?.[method];
    if (typeof fn !== 'function') {
      const available = Object.keys(plugin.instance.methods ?? {});
      throw new PluginDependencyError(
        'PLUGIN_METHOD_NOT_FOUND',
        `Plugin "${name}" has no method "${method}". Available: ${available.join(', ')}`,
        { plugin: name },
      );
    }

    return fn(...args);
  }

  /** Host-only entry point: the facade supplies the caller from its load binding. */
  callPluginFrom(callerPlugin: string, name: string, method: string, ...args: unknown[]): unknown {
    const target = this.nameMap.get(name);
    if (!target || target.status !== PluginStatus.Running) {
      throw new PluginDependencyError('PLUGIN_NOT_RUNNING', `Plugin "${name}" is not Running`, { plugin: name });
    }
    assertPluginMethodAccess(callerPlugin, target.info, method);
    return this.callPlugin(name, method, ...args);
  }
}

function assertPluginLifecycleCapability(ownerName: string, editor: PluginRuntimeHost): void {
  const ownerInfo = editor.plugin.getInfo(ownerName);
  if (!ownerInfo?.capabilities?.includes("plugin-lifecycle")) {
    throw new Error(`Plugin "${ownerName}" does not have the "plugin-lifecycle" capability`);
  }
}

function assertCurrentKitPlugin(editor: PluginRuntimeHost, pluginPath: string): PluginInfo {
  const info = editor.plugin.getInfo(pluginPath);
  if (!info) {
    throw new Error(`Plugin at ${pluginPath} is not loaded`);
  }
  if (info.kind === "builtin") {
    throw new Error(`Cannot operate on builtin plugin "${info.name}"`);
  }
  const currentKit = editor.kit.getCurrent();
  if (!currentKit || info.source.scope !== "kit" || info.source.kitId !== currentKit.name) {
    throw new Error(`Plugin "${info.name}" does not belong to the current kit`);
  }
  return info;
}

function createPluginRuntime(
  editor: PluginRuntimeHost,
  owner: PluginInfo,
  paths: SessionPluginPaths,
  identity: PluginSessionIdentity,
  configHost?: PluginConfigBindingHost,
  kitId?: string,
  credentials?: PluginCredentialVault,
): PluginRuntime {
  const ownerName = owner.name;
  const isController = (name: string) => owner.kind === 'builtin' && ownerName === name;
  const menu = editor.menu;
  const managedPluginPaths = new Set<string>();
  let managedKitName: string | null = null;

  function syncManagedPluginPaths() {
    const currentKit = editor.kit.getCurrent();
    if (managedKitName === (currentKit?.name ?? null)) return currentKit;

    managedKitName = currentKit?.name ?? null;
    managedPluginPaths.clear();
    for (const pluginName of currentKit?.plugins ?? []) {
      const info = editor.plugin.getInfo(pluginName);
      if (info) managedPluginPaths.add(path.resolve(info.path));
    }
    return currentKit;
  }

  syncManagedPluginPaths();
  const runtime: Omit<PluginRuntime, 'paths'> = {
    sessionId: editor.sessionId,
    identity: Object.freeze({ userId: identity.userId, sessionId: identity.sessionId }),
    ...(editor.i18n ? { i18n: pickCapabilities(editor.i18n, ['getLocale', 'getDefaultLocale', 'setLocale', 't', 'registerMessages', 'subscribe', 'getVisibleSnapshot']) } : {}),
    ...(editor.window ? { window: pickCapabilities(editor.window, ['getSnapshot', 'openPanel', 'markPanelInstanceFloating', 'markWindowGroupOpened', 'closeWindowGroup', 'setPanelInstanceState', 'closePanelInstance']) } : {}),
    kit: Object.assign(pickCapabilities(editor.kit, ['list', 'get', 'switchKit', 'applyLayout', 'layouts']), {
      getCurrent: () => structuredClone(editor.kit.getCurrent()),
    }),
    config: configHost?.bind(kitId ?? editor.kit.getCurrent()?.name ?? '', ownerName)
      ?? unavailablePluginConfig(),
    application: {
      request: (pluginName, name, ...args) =>
        requestFrom(editor.application, ownerName, pluginName, name, args),
    },
    plugin: {
      define: editor.plugin.define,
      getInfo: editor.plugin.getInfo,
      inspect: editor.plugin.inspect,
      getRegistration: editor.plugin.getRegistration,
      listLoaded: editor.plugin.listLoaded,
      listRegistered: editor.plugin.listRegistered,
      callPlugin: (name, method, ...args) => isController(MESSAGE_OWNER)
        ? editor.plugin.callPlugin(name, method, ...args)
        : callPluginFrom(editor.plugin, ownerName, name, method, args),
      register: async (pluginPath) => {
        assertPluginLifecycleCapability(ownerName, editor);
        const currentKit = syncManagedPluginPaths();
        if (!currentKit) {
          throw new Error("No active kit");
        }
        const normalizedPath = path.resolve(pluginPath);
        if (!managedPluginPaths.has(normalizedPath)) {
          throw new Error(`Plugin path "${pluginPath}" is not part of the current kit`);
        }
        const existing = editor.plugin.getRegistration?.(normalizedPath);
        if (existing) {
          if (existing.kind === "builtin") {
            throw new Error(`Cannot register builtin plugin at "${normalizedPath}"`);
          }
          if (existing.source.scope !== "kit" || existing.source.kitId !== currentKit.name) {
            throw new Error(`Plugin at "${normalizedPath}" does not belong to the current kit`);
          }
          return;
        }
        return editor.plugin.register!(normalizedPath, {
          source: { scope: "kit", kitId: currentKit.name },
        });
      },
      unregister: (pluginPath) => {
        assertPluginLifecycleCapability(ownerName, editor);
        const info = assertCurrentKitPlugin(editor, pluginPath);
        managedPluginPaths.add(path.resolve(info.path));
        return editor.plugin.unregister!(info.path);
      },
      load: async (pluginPath) => {
        assertPluginLifecycleCapability(ownerName, editor);
        assertCurrentKitPlugin(editor, pluginPath);
        return editor.plugin.load!(pluginPath);
      },
      unload: async (pluginPath) => {
        assertPluginLifecycleCapability(ownerName, editor);
        assertCurrentKitPlugin(editor, pluginPath);
        return editor.plugin.unload!(pluginPath);
      },
    },
    panel: {
      register: (name, modulePath, constraints) =>
        editor.panel.register(
          name,
          modulePath,
          constraints,
          resolveOwner(inferPanelOwner(name) ?? ownerName, ownerName, isController(PANEL_OWNER)),
        ),
      unregister: (name) => {
        const registration = editor.panel.getRegistration(name);
        if (registration && registration.owner !== ownerName && !isController(PANEL_OWNER)) {
          throw new Error(`Plugin "${ownerName}" cannot unregister panel "${name}" owned by "${registration.owner}"`);
        }
        editor.panel.unregister(name);
      },
      getInfo: editor.panel.getInfo,
      getRegistration: editor.panel.getRegistration,
      list: editor.panel.list,
    },
    menu: {
      attach: (pluginName, contribute) =>
        menu.attach(resolveOwner(pluginName, ownerName, isController(MENU_OWNER)), contribute),
      detach: (pluginName) =>
        menu.detach(resolveOwner(pluginName, ownerName, isController(MENU_OWNER))),
      setDefaults: (items) => {
        if (!isController(MENU_OWNER)) {
          throw new Error(`Plugin "${ownerName}" cannot set default menu`);
        }
        return editor.menu.setDefaults(items);
      },
      clearDefaults: () => {
        if (!isController(MENU_OWNER)) {
          throw new Error(`Plugin "${ownerName}" cannot clear default menu`);
        }
        return editor.menu.clearDefaults();
      },
      reset: () => isController(MENU_OWNER) ? menu.reset() : menu.detach(ownerName),
      getState: () => menu.getState(),
    },
    message: {
      registerRequest: (pluginName, name, handler, location, methods) =>
        editor.message.registerRequest(resolveOwner(pluginName, ownerName, isController(MESSAGE_OWNER)), name, handler, location, methods),
      registerBroadcast: (pluginName, topic, handler, location, methods) =>
        editor.message.registerBroadcast(resolveOwner(pluginName, ownerName, isController(MESSAGE_OWNER)), topic, handler, location, methods),
      unregisterRequest: (pluginName, name) =>
        editor.message.unregisterRequest(resolveOwner(pluginName, ownerName, isController(MESSAGE_OWNER)), name),
      unregisterBroadcast: (pluginName, topic) =>
        editor.message.unregisterBroadcast(resolveOwner(pluginName, ownerName, isController(MESSAGE_OWNER)), topic),
      request: (pluginName, name, ...args) =>
        requestFrom(editor.message, ownerName, pluginName, name, args),
      broadcast: (topic, ...args) => {
        assertBroadcastTopic(ownerName, topic);
        editor.message.broadcast(topic, ...args);
      },
    },
  };
  return { ...runtime, paths, ...(credentials ? { credentials } : {}) };
}

function createPluginDefinitionBridge(
  capture: (definition: import('./types.js').PluginDefinition) => void,
): PluginDefinitionBridge {
  const define = Object.freeze(capture.bind(undefined));
  const plugin = Object.freeze({ define });
  return Object.freeze({ plugin });
}

function createRevocableCredentialVault(credentials: PluginCredentialVault): {
  facade: PluginCredentialVault;
  revokeAndDrain(): Promise<void>;
} {
  let active = true;
  const operations = new Set<Promise<unknown>>();
  let drainPromise: Promise<void> | undefined;
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    if (!active) return Promise.reject(credentialOperationFailed());
    const result = Promise.resolve().then(operation);
    operations.add(result);
    void result.then(
      () => { operations.delete(result); },
      () => { operations.delete(result); },
    );
    return result;
  };
  const revokeAndDrain = (): Promise<void> => {
    active = false;
    drainPromise ??= (async () => {
      while (operations.size > 0) {
        await Promise.allSettled([...operations]);
      }
    })();
    return drainPromise;
  };
  return {
    facade: {
      capability: () => run(() => credentials.capability()).catch(() => ({
            mode: 'on',
            status: 'unavailable',
            reason: 'CREDENTIALS_UNAVAILABLE',
          })),
      available: async () => active && run(() => credentials.available()),
      list: () => run(() => credentials.list()),
      get: (id) => run(() => credentials.get(id)),
      put: (input) => run(() => credentials.put(input)),
      delete: (id) => run(() => credentials.delete(id)),
    },
    revokeAndDrain,
  };
}

function createApplicationPluginRuntime(
  application: ApplicationPluginRuntimeHost,
  owner: PluginInfo,
  paths: PluginPaths,
): ApplicationPluginRuntime {
  const ownerName = owner.name;
  const isController = (name: string) => owner.kind === 'builtin' && ownerName === name;
  const runtime: Omit<ApplicationPluginRuntime, 'paths'> = {
    plugin: {
      define: application.plugin.define,
      getInfo: application.plugin.getInfo,
      inspect: application.plugin.inspect,
      getRegistration: application.plugin.getRegistration,
      listLoaded: application.plugin.listLoaded,
      listRegistered: application.plugin.listRegistered,
      callPlugin: (name, method, ...args) => isController(MESSAGE_OWNER)
        ? application.plugin.callPlugin(name, method, ...args)
        : callPluginFrom(application.plugin, ownerName, name, method, args),
    },
    menu: {
      attach: (pluginName, contribute) =>
        application.menu.attach(resolveOwner(pluginName, ownerName, isController(MENU_OWNER)), contribute),
      detach: (pluginName) =>
        application.menu.detach(resolveOwner(pluginName, ownerName, isController(MENU_OWNER))),
      getState: () => application.menu.getState(),
    },
    message: {
      registerRequest: (pluginName, name, handler, location, methods) => {
        assertApplicationMessageRoute(ownerName, location, methods);
        application.message.registerRequest(
          resolveOwner(pluginName, ownerName, isController(MESSAGE_OWNER)),
          name,
          handler,
          'server',
          methods,
        );
      },
      registerBroadcast: (pluginName, topic, handler, location, methods) => {
        assertApplicationMessageRoute(ownerName, location, methods);
        application.message.registerBroadcast(
          resolveOwner(pluginName, ownerName, isController(MESSAGE_OWNER)),
          topic,
          handler,
          'server',
          methods,
        );
      },
      unregisterRequest: (pluginName, name) =>
        application.message.unregisterRequest(resolveOwner(pluginName, ownerName, isController(MESSAGE_OWNER)), name),
      unregisterBroadcast: (pluginName, topic) =>
        application.message.unregisterBroadcast(resolveOwner(pluginName, ownerName, isController(MESSAGE_OWNER)), topic),
      request: (pluginName, name, ...args) => requestFrom(application.message, ownerName, pluginName, name, args),
      broadcast: (topic, ...args) => {
        assertBroadcastTopic(ownerName, topic);
        application.message.broadcast(topic, ...args);
      },
    },
    service: {
      register: (name, value) => application.service.register(ownerName, name, value),
      unregister: (name) => application.service.unregister(ownerName, name),
      get: (name) => application.service.get(name),
    },
    host: application.host,
  };
  return { ...runtime, paths };
}

function assertApplicationMessageRoute(
  ownerName: string,
  location: import('./runtime.js').MessageLocation | undefined,
  methods: string[] | undefined,
): void {
  if ((location && location !== 'server') || methods?.some((method) => method.startsWith('panel.'))) {
    throw new Error(`Application plugin "${ownerName}" can register only server message routes`);
  }
}

function resolveOwner(requestedOwner: string, runtimeOwner: string, canDelegate: boolean): string {
  if (!requestedOwner || requestedOwner === runtimeOwner) {
    return runtimeOwner;
  }
  if (canDelegate) {
    return requestedOwner;
  }
  throw new Error(`Plugin "${runtimeOwner}" cannot register as "${requestedOwner}"`);
}

function requestFrom(
  host: Pick<PluginRuntimeHost['message'], 'requestFrom'>,
  caller: string,
  plugin: string,
  name: string,
  args: unknown[],
): Promise<unknown> {
  if (!host.requestFrom) return Promise.reject(new Error('Trusted request caller binding is unavailable'));
  return host.requestFrom(caller, plugin, name, ...args);
}

function callPluginFrom(
  host: PluginRuntimeHost['plugin'], caller: string, plugin: string, method: string, args: unknown[],
): unknown {
  if (!host.callPluginFrom) throw new Error('Trusted Plugin caller binding is unavailable');
  return host.callPluginFrom(caller, plugin, method, ...args);
}

function pickCapabilities(host: object, names: readonly string[]): Record<string, unknown> {
  const facade: Record<string, unknown> = {};
  for (const name of names) {
    if (!(name in host)) continue;
    Object.defineProperty(facade, name, {
      enumerable: true,
      get: () => {
        const value: unknown = Reflect.get(host, name);
        return typeof value === 'function' ? value.bind(host) : value;
      },
    });
  }
  return facade;
}

function assertBroadcastTopic(ownerName: string, topic: unknown): asserts topic is string {
  if (typeof topic !== "string" || topic.length === 0) {
    throw new Error(`Plugin "${ownerName}" broadcast topic must be a non-empty string`);
  }
  if (topic === "*") {
    throw new Error(`Plugin "${ownerName}" cannot broadcast to wildcard topic "*"; wildcard is reserved for subscription only`);
  }
  const prefix = `${ownerName}.`;
  if (!topic.startsWith(prefix)) {
    throw new Error(`Plugin "${ownerName}" broadcast topic "${topic}" must start with "${prefix}"`);
  }
}

function inferPanelOwner(panelName: string): string | undefined {
  const separatorIndex = panelName.lastIndexOf('.');
  return separatorIndex > 0 ? panelName.slice(0, separatorIndex) : undefined;
}
