import type { ApplicationHostMode, ApplicationPluginRuntimeHost } from '../editor/types';
import { MenuModule } from '../framework/menu';
import { MessageModule } from '../framework/message';
import { PluginModule } from '../framework/plugin';
import type { ContributeData } from '../framework/plugin/types';
import type { PluginPathRoots } from '../framework/plugin/paths';
import type {
  CredentialCapabilitySnapshot,
  CredentialMode,
} from '@itharbors/plugin-types';
import { ApplicationServiceRegistry } from './service-registry';
import type {
  ApplicationBootstrap,
  ApplicationDiagnostic,
  ApplicationEvent,
  ApplicationPhase,
  ApplicationPluginSpec,
  ApplicationPluginState,
} from './types';
import { createNotificationCapability } from './notification-capability';

export interface ApplicationRuntimeOptions {
  plugins?: ApplicationPluginSpec[];
  diagnostics?: ApplicationDiagnostic[];
  hostMode: ApplicationHostMode;
  catalogLoader?: () => Promise<{
    plugins: ApplicationPluginSpec[];
    diagnostics: ApplicationDiagnostic[];
  }>;
  pluginPathRoots: PluginPathRoots;
  notificationPort?: number;
  notificationOwnerAuthToken?: string;
  credentialMode?: CredentialMode;
  credentialStatusLoader?: () => Promise<CredentialCapabilitySnapshot>;
}

export class ApplicationRuntime {
  private phase: ApplicationPhase = 'starting';
  private readonly plugin = new PluginModule();
  private readonly message = new MessageModule();
  private readonly service = new ApplicationServiceRegistry();
  private readonly menu: MenuModule;
  private readonly pluginStates: ApplicationPluginState[] = [];
  private pluginSpecs: ApplicationPluginSpec[];
  private diagnostics: ApplicationDiagnostic[];
  private readonly listeners = new Set<(event: ApplicationEvent) => void>();
  private readonly loaded: ApplicationPluginSpec[] = [];
  private startPromise: Promise<ApplicationBootstrap> | undefined;
  private disposePromise: Promise<void> | undefined;
  private credentialStatus: CredentialCapabilitySnapshot;
  private readonly credentialMode: CredentialMode;
  private readonly credentialStatusLoader: ApplicationRuntimeOptions['credentialStatusLoader'];

  constructor(private readonly options: ApplicationRuntimeOptions) {
    this.pluginSpecs = [...(options.plugins ?? [])];
    this.diagnostics = [...(options.diagnostics ?? [])];
    this.resetPluginStates();
    this.menu = new MenuModule({ onChange: () => this.emit() });
    this.credentialMode = options.credentialMode ?? 'off';
    this.credentialStatusLoader = options.credentialStatusLoader;
    this.credentialStatus = unavailableCredentialStatus(this.credentialMode);
  }

  start(): Promise<ApplicationBootstrap> {
    if (!this.startPromise) this.startPromise = this.startInternal();
    return this.startPromise;
  }

  getBootstrap(): ApplicationBootstrap {
    return {
      phase: this.phase,
      plugins: this.pluginStates.map((state) => ({ ...state, kits: [...state.kits] })),
      diagnostics: this.diagnostics.map((item) => ({ ...item })),
      menu: structuredClone(this.menu.getState()),
      credentials: sanitizeCredentialStatus(this.credentialStatus, this.credentialMode),
    };
  }

  subscribe(listener: (event: ApplicationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  request(pluginName: string, method: string, ...args: unknown[]): Promise<unknown> {
    this.assertAvailable();
    return this.message.request(pluginName, method, ...args);
  }

  triggerMenu(menuId: string): Promise<unknown> {
    this.assertAvailable();
    return this.menu.trigger(menuId, {
      request: (pluginName, message) => this.message.request(pluginName, message),
      triggerRole: async (role) => {
        throw new Error(`Application menu role "${role}" is not supported by the server`);
      },
    });
  }

  getService<T = unknown>(name: string): T | undefined {
    return this.service.get<T>(name);
  }

  dispose(): Promise<void> {
    if (!this.disposePromise) this.disposePromise = this.disposeInternal();
    return this.disposePromise;
  }

  private async startInternal(): Promise<ApplicationBootstrap> {
    this.phase = 'starting';
    this.emit();
    if (this.credentialStatusLoader) {
      try {
        this.credentialStatus = sanitizeCredentialStatus(
          await this.credentialStatusLoader(),
          this.credentialMode,
        );
      } catch {
        this.credentialStatus = unavailableCredentialStatus(this.credentialMode);
      }
      this.emit();
    }
    if (this.options.catalogLoader) {
      try {
        const catalog = await this.options.catalogLoader();
        this.pluginSpecs = [...catalog.plugins];
        this.diagnostics = [...this.diagnostics, ...catalog.diagnostics];
        this.resetPluginStates();
      } catch (error) {
        this.pluginSpecs = [];
        this.resetPluginStates();
        this.diagnostics.push({
          code: 'INVALID_KIT_MANIFEST',
          message: `Application plugin discovery failed: ${errorMessage(error)}`,
        });
      }
    }
    for (const spec of this.pluginSpecs) {
      const state = this.pluginStates.find((item) => item.name === spec.name)!;
      try {
        await this.plugin.register(spec.path, { kind: 'external' });
        const contribute = this.plugin.getInfo(spec.name)?.contribute;
        assertApplicationContributions(spec.name, contribute);
        await this.plugin.load(spec.path, {
          scope: 'application',
          host: this.createRuntimeHost(spec),
          paths: {
            roots: this.options.pluginPathRoots,
            legacyDataDirectories: spec.legacyDataDirectories ?? [],
          },
        });
        this.attachContributions(spec.name, contribute);
        this.loaded.push(spec);
        state.status = 'running';
      } catch (error) {
        await this.rollbackOwner(spec);
        state.status = 'failed';
        state.error = errorMessage(error);
      }
      this.emit();
    }
    this.phase = this.pluginStates.some((state) => state.status === 'failed')
      || this.diagnostics.length > 0
      ? 'degraded'
      : 'ready';
    this.emit();
    return this.getBootstrap();
  }

  private createRuntimeHost(spec: ApplicationPluginSpec): ApplicationPluginRuntimeHost {
    const host = { mode: this.options.hostMode } as ApplicationPluginRuntimeHost['host'];
    Object.defineProperty(host, 'notifications', {
      enumerable: true,
      get: () => createNotificationCapability({
        hostMode: this.options.hostMode,
        permissions: spec.permissions ?? [],
        owner: spec.name,
        ownerAuthToken: this.options.notificationOwnerAuthToken,
        port: this.options.notificationPort,
      }),
    });
    Object.freeze(host);
    return {
      plugin: {
        define: () => {
          throw new Error('Plugin definitions are captured only while importing a plugin');
        },
        getInfo: (name) => this.plugin.getInfo(name),
        listLoaded: () => this.plugin.listLoaded(),
        listRegistered: () => this.plugin.listRegistered(),
        callPlugin: (name, method, ...args) => this.plugin.callPlugin(name, method, ...args),
      },
      menu: {
        attach: (owner, contribute) => this.menu.attach(owner, contribute),
        detach: (owner) => this.menu.detach(owner),
        getState: () => this.menu.getState(),
      },
      message: {
        registerRequest: (owner, name, handler, location, methods) =>
          this.message.registerRequest(owner, name, handler, location, methods),
        registerBroadcast: (owner, topic, handler, location, methods) =>
          this.message.registerBroadcast(owner, topic, handler, location, methods),
        unregisterRequest: (owner, name) => this.message.unregisterRequest(owner, name),
        unregisterBroadcast: (owner, topic) => this.message.unregisterBroadcast(owner, topic),
        request: (owner, name, ...args) => this.message.request(owner, name, ...args),
        broadcast: (topic, ...args) => this.message.broadcast(topic, ...args),
      },
      service: {
        register: (owner, name, value) => this.service.register(owner, name, value),
        unregister: (owner, name) => this.service.unregister(owner, name),
        get: (name) => this.service.get(name),
      },
      host,
    };
  }

  private attachContributions(pluginName: string, contribute: ContributeData | undefined): void {
    if (!contribute) return;
    this.menu.attach(pluginName, contribute);
    for (const [messageName, methods] of Object.entries(contribute.message?.request ?? {})) {
      this.message.registerRequest(
        pluginName,
        messageName,
        (...args) => this.callContributedMethod(pluginName, messageName, methods, args),
        'server',
        methods,
      );
    }
    for (const [topic, methods] of Object.entries(contribute.message?.broadcast ?? {})) {
      this.message.registerBroadcast(
        pluginName,
        topic,
        (...args) => {
          for (const method of methods) this.plugin.callPlugin(pluginName, method, ...args);
        },
        'server',
        methods,
      );
    }
  }

  private callContributedMethod(
    pluginName: string,
    messageName: string,
    methods: string[],
    args: unknown[],
  ): unknown {
    if (methods.length === 1) return this.plugin.callPlugin(pluginName, methods[0], ...args);
    const [method, ...rest] = args;
    if (typeof method === 'string' && methods.includes(method)) {
      return this.plugin.callPlugin(pluginName, method, ...rest);
    }
    throw new Error(`Message "${messageName}" requires one of: ${methods.join(', ')}`);
  }

  private async rollbackOwner(spec: ApplicationPluginSpec): Promise<void> {
    try {
      await this.plugin.unload(spec.path);
    } catch {
      // The original startup error remains the plugin status cause.
    } finally {
      this.clearOwner(spec.name);
    }
  }

  private clearOwner(owner: string): void {
    this.menu.detach(owner);
    this.message.clearOwner(owner);
    this.service.clearOwner(owner);
  }

  private async disposeInternal(): Promise<void> {
    if (this.phase === 'stopped') return;
    await this.startPromise;
    this.phase = 'stopping';
    this.emit();
    const errors: unknown[] = [];
    for (const spec of [...this.loaded].reverse()) {
      try {
        await this.plugin.unload(spec.path);
      } catch (error) {
        errors.push(error);
      } finally {
        this.clearOwner(spec.name);
        const state = this.pluginStates.find((item) => item.name === spec.name);
        if (state) state.status = 'stopped';
      }
    }
    this.loaded.length = 0;
    this.message.destroy();
    this.menu.destroy();
    this.service.clear();
    this.phase = 'stopped';
    this.emit();
    this.listeners.clear();
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Application plugin cleanup failed');
  }

  private assertAvailable(): void {
    if (this.phase !== 'ready' && this.phase !== 'degraded') {
      throw new Error(`Application Runtime is ${this.phase}`);
    }
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const event: ApplicationEvent = { type: 'application-bootstrap', bootstrap: this.getBootstrap() };
    for (const listener of this.listeners) listener(event);
  }

  private resetPluginStates(): void {
    this.pluginStates.length = 0;
    this.pluginStates.push(...this.pluginSpecs.map((spec) => ({
      name: spec.name,
      path: spec.path,
      kits: [...spec.kits],
      status: 'pending' as const,
    })));
  }
}

function assertApplicationContributions(pluginName: string, contribute: ContributeData | undefined): void {
  if (!contribute) return;
  for (const field of ['panel', 'window', 'layout']) {
    if (contribute[field] !== undefined) {
      throw new Error(`Application plugin "${pluginName}" cannot contribute ${field}`);
    }
  }
  for (const methods of [
    ...Object.values(contribute.message?.request ?? {}),
    ...Object.values(contribute.message?.broadcast ?? {}),
  ]) {
    if (!Array.isArray(methods) || methods.length === 0 || methods.some((method) => (
      typeof method !== 'string' || method.startsWith('panel.')
    ))) {
      throw new Error(`Application plugin "${pluginName}" can contribute only server message methods`);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unavailableCredentialStatus(mode: CredentialMode): CredentialCapabilitySnapshot {
  return mode === 'off'
    ? { mode, status: 'unavailable', reason: 'CREDENTIALS_DISABLED' }
    : { mode, status: 'unavailable', reason: 'CREDENTIALS_UNAVAILABLE' };
}

function sanitizeCredentialStatus(
  value: CredentialCapabilitySnapshot,
  configuredMode: CredentialMode,
): CredentialCapabilitySnapshot {
  if (!value || value.mode !== configuredMode) {
    return unavailableCredentialStatus(configuredMode);
  }
  if (configuredMode === 'local' && value.status === 'available') {
    return { mode: configuredMode, status: 'available' };
  }
  if (value.status === 'unavailable') {
    if (configuredMode === 'off' && value.reason === 'CREDENTIALS_DISABLED') {
      return { mode: configuredMode, status: 'unavailable', reason: value.reason };
    }
    if (
      configuredMode === 'local'
      && ['CREDENTIALS_UNAVAILABLE', 'CREDENTIALS_LOCKED'].includes(value.reason)
    ) {
      return { mode: configuredMode, status: 'unavailable', reason: value.reason };
    }
    if (configuredMode === 'multi-user' && value.reason === 'CREDENTIALS_UNAVAILABLE') {
      return { mode: configuredMode, status: 'unavailable', reason: value.reason };
    }
  }
  return unavailableCredentialStatus(configuredMode);
}
