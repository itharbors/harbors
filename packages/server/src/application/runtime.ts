import path from 'node:path';
import type { ApplicationHostMode, NotificationInput } from '../editor/types';
import { MenuModule } from '../framework/menu';
import { MessageModule } from '../framework/message';
import { PluginModule } from '../framework/plugin';
import { createPluginPaths, type PluginPathRoots, type PluginPaths } from '../framework/plugin/paths';
import type { ContributeData, PluginInfo } from '../framework/plugin/types';
import type {
  CredentialCapabilitySnapshot,
  CredentialMode,
} from '@itharbors/plugin-types';
import { createNotificationCapability } from './notification-capability';
import type {
  ApplicationPluginDefinitionMetadata,
  ApplicationPluginRuntimeSnapshot,
  InitializeApplicationPluginPayload,
  RuntimeCommand,
} from './plugin-process/runner-runtime';
import type { ApplicationPluginProcessRuntimeOptions } from './plugin-process/spawn';
import {
  createApplicationPluginSupervisor,
  type ApplicationPluginSupervisor,
  type ApplicationPluginSupervisorOptions,
} from './plugin-process/supervisor';
import type { ApplicationPluginProcessState } from './plugin-process/types';
import { ApplicationServiceRegistry } from './service-registry';
import type {
  ApplicationBootstrap,
  ApplicationDiagnostic,
  ApplicationEvent,
  ApplicationPhase,
  ApplicationPluginSpec,
  ApplicationPluginState,
} from './types';

const PROCESS_NOT_CONFIGURED = 'APPLICATION_PLUGIN_PROCESS_NOT_CONFIGURED';
const PROCESS_FAILED = 'APPLICATION_PLUGIN_PROCESS_FAILED';
const MANIFEST_INVALID = 'APPLICATION_PLUGIN_MANIFEST_INVALID';
const CONTRIBUTION_INVALID = 'APPLICATION_PLUGIN_CONTRIBUTION_INVALID';
const LIFECYCLE_OPERATION_TIMEOUT_MS = 30_000;

export type ApplicationPluginSupervisorController = Pick<
  ApplicationPluginSupervisor,
  | 'start'
  | 'stop'
  | 'retry'
  | 'invoke'
  | 'invokeHandler'
  | 'attach'
  | 'detach'
  | 'updateRuntimeSnapshot'
  | 'getState'
  | 'getDefinition'
  | 'subscribe'
>;

export type ApplicationRuntimePluginSupervisorOptions = Omit<
  ApplicationPluginSupervisorOptions,
  'process'
> & { process?: ApplicationPluginProcessRuntimeOptions };

export type CreateApplicationPluginSupervisor = (
  options: ApplicationRuntimePluginSupervisorOptions,
) => ApplicationPluginSupervisorController;

export interface ApplicationRuntimeOptions {
  plugins?: ApplicationPluginSpec[];
  diagnostics?: ApplicationDiagnostic[];
  hostMode: ApplicationHostMode;
  catalogLoader?: () => Promise<{
    plugins: ApplicationPluginSpec[];
    diagnostics: ApplicationDiagnostic[];
  }>;
  pluginPathRoots: PluginPathRoots;
  processRuntime?: ApplicationPluginProcessRuntimeOptions;
  createPluginSupervisor?: CreateApplicationPluginSupervisor;
  notificationPort?: number;
  notificationOwnerAuthToken?: string;
  credentialMode?: CredentialMode;
  credentialStatusLoader?: () => Promise<CredentialCapabilitySnapshot>;
}

interface PreparedPlugin {
  readonly spec: ApplicationPluginSpec;
  readonly info: PluginInfo;
  readonly entryPath: string;
  readonly paths: PluginPaths;
  readonly contribute?: ContributeData;
}

interface SnapshotDelivery {
  inFlight: boolean;
  latest?: ApplicationPluginRuntimeSnapshot;
}

interface LifecycleAttachment {
  readonly observerGeneration: string;
  readonly attachedGeneration: string;
}

export class ApplicationRuntime {
  private phase: ApplicationPhase = 'starting';
  private readonly manifestRegistry = new PluginModule();
  private readonly message = new MessageModule();
  private readonly service = new ApplicationServiceRegistry();
  private readonly menu: MenuModule;
  private readonly pluginStates: ApplicationPluginState[] = [];
  private pluginSpecs: ApplicationPluginSpec[];
  private diagnostics: ApplicationDiagnostic[];
  private readonly listeners = new Set<(event: ApplicationEvent) => void>();
  private readonly prepared = new Map<string, PreparedPlugin>();
  private readonly supervisors = new Map<string, ApplicationPluginSupervisorController>();
  private readonly supervisorOrder: string[] = [];
  private readonly staticAttached = new Set<string>();
  private readonly lifecycleAttachments = new Map<string, LifecycleAttachment>();
  private readonly lifecycleTransitions = new Map<string, Promise<void>>();
  private readonly lifecycleTransitioning = new Set<string>();
  private readonly snapshotDeliveries = new Map<string, SnapshotDelivery>();
  private readonly clearingOwners = new Set<string>();
  private readonly failingFromSnapshot = new Set<string>();
  private readonly definitionFailures = new Map<string, Promise<void>>();
  private startPromise: Promise<ApplicationBootstrap> | undefined;
  private disposePromise: Promise<void> | undefined;
  private terminalIntent = false;
  private credentialStatus: CredentialCapabilitySnapshot;
  private readonly credentialMode: CredentialMode;
  private readonly credentialStatusLoader: ApplicationRuntimeOptions['credentialStatusLoader'];
  private readonly createPluginSupervisor: CreateApplicationPluginSupervisor;
  private readonly processRuntime: ApplicationPluginProcessRuntimeOptions | undefined;
  private readonly hostMode: ApplicationHostMode;
  private readonly pluginPathRoots: PluginPathRoots;
  private readonly notificationPort: number | undefined;
  private readonly notificationOwnerAuthToken: string | undefined;
  private readonly requiresProcessRuntime: boolean;
  private startupComplete = false;

  constructor(private readonly options: ApplicationRuntimeOptions) {
    this.pluginSpecs = [...(options.plugins ?? [])];
    this.diagnostics = [...(options.diagnostics ?? [])];
    this.resetPluginStates();
    this.menu = new MenuModule({ onChange: () => this.onRuntimeSnapshotChanged() });
    this.credentialMode = options.credentialMode ?? 'off';
    this.credentialStatusLoader = options.credentialStatusLoader;
    this.credentialStatus = unavailableCredentialStatus(this.credentialMode);
    this.requiresProcessRuntime = options.createPluginSupervisor === undefined;
    this.createPluginSupervisor = options.createPluginSupervisor ?? ((supervisorOptions) => {
      if (!supervisorOptions.process) throw new Error('Application plugin process is not configured');
      return createApplicationPluginSupervisor({ ...supervisorOptions, process: supervisorOptions.process });
    });
    this.processRuntime = options.processRuntime;
    this.hostMode = options.hostMode;
    this.pluginPathRoots = { ...options.pluginPathRoots };
    this.notificationPort = options.notificationPort;
    this.notificationOwnerAuthToken = options.notificationOwnerAuthToken;
  }

  start(): Promise<ApplicationBootstrap> {
    if (this.terminalIntent) return Promise.reject(createApplicationRuntimeUnavailableError());
    if (!this.startPromise) {
      this.startPromise = Promise.resolve().then(() => this.startInternal());
    }
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

  async retryPlugin(name: string): Promise<ApplicationBootstrap> {
    if (this.terminalIntent) throw createApplicationRuntimeUnavailableError();
    await this.start();
    if (this.terminalIntent) throw createApplicationRuntimeUnavailableError();
    this.assertAvailable();
    const supervisor = this.supervisors.get(name);
    if (!supervisor) throw createStableUnavailableError(name);
    this.lifecycleTransitioning.add(name);
    try {
      try {
        await supervisor.retry();
      } catch {
        if (this.terminalIntent) throw createApplicationRuntimeUnavailableError();
        return this.getBootstrap();
      }
      if (this.terminalIntent) throw createApplicationRuntimeUnavailableError();
      await this.definitionFailures.get(name);
      if (this.terminalIntent) throw createApplicationRuntimeUnavailableError();
      if (supervisor.getState().status !== 'running') return this.getBootstrap();
      try {
        await this.attachPluginLifecycle(name);
      } catch {
        await this.failRunningPlugin(name, CONTRIBUTION_INVALID);
      }
      if (this.terminalIntent) throw createApplicationRuntimeUnavailableError();
    } finally {
      this.lifecycleTransitioning.delete(name);
    }
    this.refreshPhase();
    this.emit();
    if (this.terminalIntent) throw createApplicationRuntimeUnavailableError();
    return this.getBootstrap();
  }

  dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.terminalIntent = true;
      if (this.phase !== 'stopped') {
        this.phase = 'stopping';
        this.emit();
      }
      this.disposePromise = this.disposeInternal();
    }
    return this.disposePromise;
  }

  private async startInternal(): Promise<ApplicationBootstrap> {
    this.assertNotTerminal();
    this.phase = 'starting';
    this.emit();
    this.assertNotTerminal();
    await this.loadCredentialStatus();
    this.assertNotTerminal();
    await this.loadCatalog();
    this.assertNotTerminal();
    await this.preparePlugins();
    for (const spec of this.pluginSpecs) {
      if (this.terminalIntent) break;
      if (this.prepared.has(spec.name)) await this.startPlugin(spec.name);
    }
    this.assertNotTerminal();
    this.startupComplete = true;
    for (const name of this.supervisorOrder) {
      if (this.terminalIntent) break;
      if (this.supervisors.get(name)?.getState().status !== 'running') continue;
      try {
        await this.attachPluginLifecycle(name);
      } catch {
        await this.failRunningPlugin(name, CONTRIBUTION_INVALID);
      }
    }
    this.assertNotTerminal();
    this.refreshPhase();
    this.emit();
    this.assertNotTerminal();
    return this.getBootstrap();
  }

  private assertNotTerminal(): void {
    if (this.terminalIntent) throw createApplicationRuntimeUnavailableError();
  }

  private async loadCredentialStatus(): Promise<void> {
    if (!this.credentialStatusLoader) return;
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

  private async loadCatalog(): Promise<void> {
    if (!this.options.catalogLoader) return;
    try {
      const catalog = await this.options.catalogLoader();
      this.pluginSpecs = [...catalog.plugins];
      this.diagnostics = [...this.diagnostics, ...catalog.diagnostics];
      this.resetPluginStates();
    } catch {
      this.pluginSpecs = [];
      this.resetPluginStates();
      this.diagnostics.push({
        code: 'INVALID_KIT_MANIFEST',
        message: 'Application plugin discovery failed',
      });
    }
  }

  private async preparePlugins(): Promise<void> {
    this.prepared.clear();
    for (const spec of this.pluginSpecs) {
      try {
        await this.manifestRegistry.register(spec.path, { kind: 'external' });
        const info = this.manifestRegistry.getInfo(spec.path);
        if (!info || info.name !== spec.name) throw new Error('Application plugin manifest name mismatch');
        assertApplicationContributions(spec.name, info.contribute);
        const pluginPaths = await createPluginPaths({
          roots: this.pluginPathRoots,
          owner: spec.name,
          legacyDataDirectories: spec.legacyDataDirectories ?? [],
        });
        this.prepared.set(spec.name, {
          spec,
          info,
          entryPath: path.resolve(info.path, info.entry),
          paths: pluginPaths,
          ...(info.contribute ? { contribute: structuredClone(info.contribute) } : {}),
        });
      } catch {
        this.failPluginState(spec.name, MANIFEST_INVALID);
      }
      this.emit();
    }
  }

  private async startPlugin(name: string): Promise<void> {
    const prepared = this.prepared.get(name)!;
    if (!this.processRuntime && this.requiresProcessRuntime) {
      this.failPluginState(name, PROCESS_NOT_CONFIGURED);
      this.emit();
      return;
    }
    let supervisor: ApplicationPluginSupervisorController;
    try {
      supervisor = this.createPluginSupervisor({
        plugin: name,
        ...(this.processRuntime ? { process: this.processRuntime } : {}),
        host: {
          initializePayload: (generation) => this.createInitializePayload(prepared, generation),
          handleRuntimeCommand: (_plugin, command) => this.handleRuntimeCommand(name, command),
          clearOwner: () => this.clearOwner(name),
          onStateChanged: (state) => this.onSupervisorStateChanged(name, state),
        },
      });
      this.supervisors.set(name, supervisor);
      this.supervisorOrder.push(name);
    } catch {
      this.failPluginState(name, PROCESS_FAILED);
      this.emit();
      return;
    }
    this.lifecycleTransitioning.add(name);
    try {
      try {
        await supervisor.start();
      } catch {
        const state = this.pluginState(name);
        if (state.status === 'pending' || state.status === 'starting') {
          this.failPluginState(name, PROCESS_FAILED);
        }
        return;
      }
      await this.definitionFailures.get(name);
      if (supervisor.getState().status !== 'running') return;
      try {
        await this.attachPluginLifecycle(name);
      } catch {
        await this.failRunningPlugin(name, CONTRIBUTION_INVALID);
      }
    } finally {
      this.lifecycleTransitioning.delete(name);
    }
    this.emit();
  }

  private createInitializePayload(
    prepared: PreparedPlugin,
    _generation: string,
  ): InitializeApplicationPluginPayload {
    return {
      entryPath: prepared.entryPath,
      pluginName: prepared.spec.name,
      runtime: {
        paths: {
          data: prepared.paths.data,
          cache: prepared.paths.cache,
          temp: prepared.paths.temp,
          legacyData: [...prepared.paths.legacyData],
        },
        hostMode: this.hostMode,
        pluginSnapshot: this.pluginSnapshot(),
        menuSnapshot: structuredClone(this.menu.getState()),
        serviceSnapshot: this.service.snapshot(),
        notificationCapability: this.hasNotificationCapability(prepared.spec),
      },
    };
  }

  private async handleRuntimeCommand(pluginName: string, command: RuntimeCommand): Promise<unknown> {
    const spec = this.prepared.get(pluginName)?.spec;
    if (!spec) throw createStableUnavailableError(pluginName);
    switch (command.target) {
      case 'plugin':
        if (command.operation === 'call') {
          return this.requireSupervisor(command.plugin).invoke(command.method, command.args);
        }
        break;
      case 'menu':
        if (command.operation === 'attach') {
          assertApplicationContributions(pluginName, command.contribute);
          this.menu.attach(pluginName, command.contribute);
          return null;
        }
        if (command.operation === 'detach') {
          this.menu.detach(pluginName);
          return null;
        }
        break;
      case 'message':
        switch (command.operation) {
          case 'register-request':
            assertServerRoute(pluginName, command.location, command.methods);
            this.message.registerRequest(
              pluginName,
              command.name,
              (...args) => this.requireSupervisor(pluginName).invokeHandler(command.handlerId, args),
              'server',
              command.methods,
            );
            return null;
          case 'register-broadcast':
            assertServerRoute(pluginName, command.location, command.methods);
            this.message.registerBroadcast(
              pluginName,
              command.topic,
              (...args) => {
                try {
                  void this.requireSupervisor(pluginName)
                    .invokeHandler(command.handlerId, args)
                    .catch(() => undefined);
                } catch {
                  // Broadcast is fire-and-forget even when its child is unavailable.
                }
              },
              'server',
              [],
            );
            return null;
          case 'unregister-request':
            this.message.unregisterRequest(pluginName, command.name);
            return null;
          case 'unregister-broadcast':
            this.message.unregisterBroadcast(pluginName, command.topic);
            return null;
          case 'request':
            return this.message.request(command.plugin, command.name, ...command.args);
          case 'broadcast':
            this.message.broadcast(command.topic, ...command.args);
            return null;
        }
        break;
      case 'service':
        if (command.operation === 'register') {
          this.service.register(pluginName, command.name, command.value);
          this.broadcastRuntimeSnapshot();
          return null;
        }
        if (command.operation === 'unregister') {
          this.service.unregister(pluginName, command.name);
          this.broadcastRuntimeSnapshot();
          return null;
        }
        break;
      case 'notifications': {
        const notifications = this.notificationCapability(spec);
        switch (command.operation) {
          case 'create': return notifications.create(command.input as NotificationInput);
          case 'list': return notifications.list();
          case 'mark-read': return notifications.markRead(command.id);
          case 'mark-all-read': return notifications.markAllRead();
          case 'remove': return notifications.remove(command.id);
        }
        break;
      }
    }
    throw new TypeError('Application plugin runtime command is not supported');
  }

  private onSupervisorStateChanged(name: string, processState: ApplicationPluginProcessState): void {
    const state = this.pluginState(name);
    applyProcessState(state, processState);
    if (processState.status === 'running') {
      try {
        this.assertDefinitionSupportsContributions(
          name,
          this.prepared.get(name)?.contribute,
          this.supervisors.get(name)?.getDefinition(),
        );
        this.attachContributions(name, this.prepared.get(name)?.contribute);
      } catch {
        void this.failInvalidDefinition(name);
        return;
      }
      if (this.startupComplete && !this.lifecycleTransitioning.has(name)) {
        void this.attachPluginLifecycle(name)
          .catch(() => this.failRunningPlugin(name, CONTRIBUTION_INVALID));
      }
    }
    if (this.startupComplete) this.refreshPhase();
    this.emit();
  }

  private assertDefinitionSupportsContributions(
    pluginName: string,
    contribute: ContributeData | undefined,
    definition: ApplicationPluginDefinitionMetadata | undefined,
  ): void {
    if (!definition) throw new TypeError(`Application plugin "${pluginName}" has no definition metadata`);
    const methods = new Set(definition.methods);
    const declaredMethods = [
      ...Object.values(contribute?.message?.request ?? {}).flat(),
      ...Object.values(contribute?.message?.broadcast ?? {}).flat(),
    ];
    for (const method of declaredMethods) {
      if (!methods.has(method)) {
        throw new TypeError(`Application plugin "${pluginName}" does not define method "${method}"`);
      }
    }
  }

  private failInvalidDefinition(name: string): Promise<void> {
    const existing = this.definitionFailures.get(name);
    if (existing) return existing;
    const failure = this.failRunningPlugin(name, CONTRIBUTION_INVALID)
      .finally(() => {
        if (this.definitionFailures.get(name) === failure) this.definitionFailures.delete(name);
      });
    this.definitionFailures.set(name, failure);
    return failure;
  }

  private attachContributions(pluginName: string, contribute: ContributeData | undefined): void {
    if (this.staticAttached.has(pluginName)) return;
    if (contribute) {
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
        for (const method of methods) {
          this.message.registerBroadcast(
            pluginName,
            topic,
            (...args) => {
              void this.requireSupervisor(pluginName).invoke(method, args).catch(() => undefined);
            },
            'server',
            [method],
          );
        }
      }
    }
    this.staticAttached.add(pluginName);
    this.onRuntimeSnapshotChanged();
  }

  private callContributedMethod(
    pluginName: string,
    messageName: string,
    methods: string[],
    args: unknown[],
  ): Promise<unknown> {
    if (methods.length === 1) return this.requireSupervisor(pluginName).invoke(methods[0]!, args);
    const [method, ...rest] = args;
    if (typeof method === 'string' && methods.includes(method)) {
      return this.requireSupervisor(pluginName).invoke(method, rest);
    }
    return Promise.reject(new Error(`Message "${messageName}" requires one of: ${methods.join(', ')}`));
  }

  private async clearOwner(owner: string): Promise<void> {
    this.clearingOwners.add(owner);
    try {
      for (const [key, attachment] of [...this.lifecycleAttachments]) {
        const [observer, attached] = key.split('\0');
        if (observer !== owner && attached === owner) {
          const supervisor = this.supervisors.get(observer!);
          if (supervisor) this.queueLifecycleDetachment(
            key,
            observer!,
            supervisor,
            owner,
            attachment,
          );
        }
        if ((observer === owner || attached === owner)
          && this.lifecycleAttachments.get(key) === attachment) {
          this.lifecycleAttachments.delete(key);
        }
      }
      this.staticAttached.delete(owner);
      this.menu.detach(owner);
      this.message.clearOwner(owner);
      this.service.clearOwner(owner);
      this.broadcastRuntimeSnapshot();
    } finally {
      this.clearingOwners.delete(owner);
    }
  }

  private async attachPluginLifecycle(name: string): Promise<void> {
    const supervisor = this.requireSupervisor(name);
    if (supervisor.getState().status !== 'running') return;
    const contribute = this.prepared.get(name)?.contribute;
    for (const otherName of this.supervisorOrder) {
      if (otherName === name) continue;
      const other = this.supervisors.get(otherName);
      if (other?.getState().status !== 'running') continue;
      const otherContribute = this.prepared.get(otherName)?.contribute;
      if (otherContribute) await this.attachFromNewObserver(name, otherName, otherContribute);
      if (contribute) await this.attachToExistingObserver(otherName, name, contribute);
    }
  }

  private async attachFromNewObserver(
    observer: string,
    attached: string,
    contribute: ContributeData,
  ): Promise<void> {
    const observerSupervisor = this.requireSupervisor(observer);
    const attachedSupervisor = this.requireSupervisor(attached);
    const observerGeneration = observerSupervisor.getState().generation;
    const attachedGeneration = attachedSupervisor.getState().generation;
    try {
      await this.attachPluginTo(observer, attached, contribute);
    } catch (error) {
      if (isApplicationPluginUnavailable(error)
        || !this.isCurrentLifecyclePair(
          observerSupervisor,
          observerGeneration,
          attachedSupervisor,
          attachedGeneration,
        )) return;
      throw error;
    }
  }

  private async attachToExistingObserver(
    observer: string,
    attached: string,
    contribute: ContributeData,
  ): Promise<void> {
    const supervisor = this.requireSupervisor(observer);
    const attachedSupervisor = this.requireSupervisor(attached);
    const observerGeneration = supervisor.getState().generation;
    const attachedGeneration = attachedSupervisor.getState().generation;
    try {
      await this.attachPluginTo(observer, attached, contribute);
    } catch (error) {
      if (isApplicationPluginUnavailable(error)
        || !this.isCurrentLifecyclePair(
          supervisor,
          observerGeneration,
          attachedSupervisor,
          attachedGeneration,
        )) return;
      await this.failRunningPlugin(observer, CONTRIBUTION_INVALID);
    }
  }

  private isCurrentLifecyclePair(
    observer: ApplicationPluginSupervisorController,
    observerGeneration: string | null,
    attached: ApplicationPluginSupervisorController,
    attachedGeneration: string | null,
  ): boolean {
    const observerState = observer.getState();
    const attachedState = attached.getState();
    return observerState.status === 'running'
      && attachedState.status === 'running'
      && observerState.generation === observerGeneration
      && attachedState.generation === attachedGeneration;
  }

  private async attachPluginTo(
    observer: string,
    attached: string,
    contribute: ContributeData,
  ): Promise<void> {
    const key = `${observer}\0${attached}`;
    const observerSupervisor = this.requireSupervisor(observer);
    const attachedSupervisor = this.requireSupervisor(attached);
    const observerState = observerSupervisor.getState();
    const attachedState = attachedSupervisor.getState();
    if (observerState.status !== 'running' || attachedState.status !== 'running'
      || !observerState.generation || !attachedState.generation) return;
    const expected: LifecycleAttachment = {
      observerGeneration: observerState.generation,
      attachedGeneration: attachedState.generation,
    };
    const existing = this.lifecycleAttachments.get(key);
    if (existing?.observerGeneration === expected.observerGeneration
      && existing.attachedGeneration === expected.attachedGeneration) {
      await this.lifecycleTransitions.get(key);
      return;
    }
    const attachment = { ...expected };
    this.lifecycleAttachments.set(key, attachment);
    await this.queueLifecycleTransition(key, async () => {
      const currentObserver = observerSupervisor.getState();
      const currentAttached = attachedSupervisor.getState();
      if (this.lifecycleAttachments.get(key) !== attachment) return;
      if (currentObserver.status !== 'running' || currentAttached.status !== 'running'
        || currentObserver.generation !== expected.observerGeneration
        || currentAttached.generation !== expected.attachedGeneration) {
        this.lifecycleAttachments.delete(key);
        return;
      }
      try {
        await withLifecycleOperationTimeout(observerSupervisor.attach(attached, contribute), 'attach');
      } catch (error) {
        if (isLifecycleOperationTimeout(error)) {
          const currentObserver = observerSupervisor.getState();
          if (currentObserver.status === 'running'
            && currentObserver.generation === expected.observerGeneration) {
            await this.failRunningPlugin(observer, CONTRIBUTION_INVALID);
          }
        }
        if (this.lifecycleAttachments.get(key) === attachment) {
          this.lifecycleAttachments.delete(key);
        }
        throw error;
      }
    });
  }

  private queueLifecycleDetachment(
    key: string,
    observer: string,
    supervisor: ApplicationPluginSupervisorController,
    attached: string,
    attachment: LifecycleAttachment,
  ): void {
    void this.queueLifecycleTransition(key, async () => {
      const state = supervisor.getState();
      if (state.status !== 'running' || state.generation !== attachment.observerGeneration) return;
      try {
        await withLifecycleOperationTimeout(supervisor.detach(attached), 'detach');
      } catch (error) {
        if (isLifecycleOperationTimeout(error)) {
          const current = supervisor.getState();
          if (current.status === 'running'
            && current.generation === attachment.observerGeneration) {
            await this.failRunningPlugin(observer, CONTRIBUTION_INVALID);
          }
        }
        // A different plugin cannot block mandatory owner cleanup.
      }
    });
  }

  private queueLifecycleTransition<T>(key: string, transition: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleTransitions.get(key) ?? Promise.resolve();
    const result = previous.then(transition);
    const tail = result.then(() => undefined, () => undefined);
    this.lifecycleTransitions.set(key, tail);
    void tail.then(() => {
      if (this.lifecycleTransitions.get(key) === tail) this.lifecycleTransitions.delete(key);
    });
    return result;
  }

  private async failRunningPlugin(name: string, errorCode: string): Promise<void> {
    await this.clearOwner(name);
    try {
      await this.supervisors.get(name)?.stop();
    } catch {
      // The stable bootstrap error remains authoritative.
    }
    this.failPluginState(name, errorCode);
    if (this.startupComplete) this.refreshPhase();
    this.emit();
  }

  private broadcastRuntimeSnapshot(): void {
    const snapshot = this.runtimeSnapshot();
    for (const [name, supervisor] of this.supervisors) {
      if (this.clearingOwners.has(name) || supervisor.getState().status !== 'running') continue;
      const delivery = this.snapshotDeliveries.get(name) ?? { inFlight: false };
      delivery.latest = structuredClone(snapshot);
      this.snapshotDeliveries.set(name, delivery);
      if (!delivery.inFlight) void this.drainRuntimeSnapshots(name, supervisor, delivery);
    }
  }

  private async drainRuntimeSnapshots(
    name: string,
    supervisor: ApplicationPluginSupervisorController,
    delivery: SnapshotDelivery,
  ): Promise<void> {
    delivery.inFlight = true;
    while (this.supervisors.get(name) === supervisor && supervisor.getState().status === 'running') {
      const snapshot = delivery.latest;
      if (!snapshot) break;
      delete delivery.latest;
      const generation = supervisor.getState().generation;
      try {
        await supervisor.updateRuntimeSnapshot(snapshot);
      } catch (error) {
        delivery.inFlight = false;
        const currentState = supervisor.getState();
        if (isApplicationPluginUnavailable(error)) {
          if (delivery.latest && currentState.status === 'running'
            && currentState.generation !== generation && !this.clearingOwners.has(name)) {
            void this.drainRuntimeSnapshots(name, supervisor, delivery);
          }
          return;
        }
        if (this.supervisors.get(name) === supervisor && currentState.status === 'running'
          && !this.failingFromSnapshot.has(name)) {
          this.failingFromSnapshot.add(name);
          void this.failRunningPlugin(name, PROCESS_FAILED)
            .finally(() => this.failingFromSnapshot.delete(name));
        }
        return;
      }
    }
    delivery.inFlight = false;
  }

  private onRuntimeSnapshotChanged(): void {
    this.broadcastRuntimeSnapshot();
    this.emit();
  }

  private runtimeSnapshot(): ApplicationPluginRuntimeSnapshot {
    return {
      pluginSnapshot: this.pluginSnapshot(),
      menuSnapshot: structuredClone(this.menu.getState()),
      serviceSnapshot: this.service.snapshot(),
    };
  }

  private pluginSnapshot(): Array<{ name: string; path: string }> {
    return this.pluginSpecs
      .filter((spec) => this.prepared.has(spec.name))
      .map((spec) => ({ name: spec.name, path: spec.path }));
  }

  private hasNotificationCapability(spec: ApplicationPluginSpec): boolean {
    return this.hostMode === 'desktop'
      && spec.permissions?.includes('notifications') === true
      && Number.isInteger(this.notificationPort)
      && this.notificationPort! >= 1
      && this.notificationPort! <= 65_535
      && typeof this.notificationOwnerAuthToken === 'string'
      && this.notificationOwnerAuthToken.length > 0;
  }

  private notificationCapability(spec: ApplicationPluginSpec) {
    return createNotificationCapability({
      hostMode: this.hostMode,
      permissions: spec.permissions ?? [],
      owner: spec.name,
      ownerAuthToken: this.notificationOwnerAuthToken,
      port: this.notificationPort,
    });
  }

  private requireSupervisor(name: string): ApplicationPluginSupervisorController {
    const supervisor = this.supervisors.get(name);
    if (!supervisor) throw createStableUnavailableError(name);
    return supervisor;
  }

  private async disposeInternal(): Promise<void> {
    if (this.phase === 'stopped') return;
    const errors: unknown[] = [];
    try {
      await this.startPromise;
    } catch (error) {
      if (!isApplicationRuntimeUnavailable(error)) errors.push(error);
    }
    for (const name of [...this.supervisorOrder].reverse()) {
      try {
        await this.supervisors.get(name)?.stop();
      } catch (error) {
        errors.push(error);
      } finally {
        await this.clearOwner(name);
      }
    }
    this.supervisorOrder.length = 0;
    this.message.destroy();
    this.menu.destroy();
    this.service.clear();
    this.phase = 'stopped';
    this.emit();
    this.listeners.clear();
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Application plugin cleanup failed');
  }

  private refreshPhase(): void {
    if (this.phase === 'stopping' || this.phase === 'stopped') return;
    this.phase = this.diagnostics.length === 0
      && this.pluginStates.every((state) => state.status === 'running')
      ? 'ready'
      : 'degraded';
  }

  private assertAvailable(): void {
    if (this.phase !== 'ready' && this.phase !== 'degraded') {
      throw new Error(`Application Runtime is ${this.phase}`);
    }
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const event: ApplicationEvent = { type: 'application-bootstrap', bootstrap: this.getBootstrap() };
    for (const listener of this.listeners) {
      try {
        const result = listener(event) as unknown;
        if (result && (typeof result === 'object' || typeof result === 'function')
          && typeof (result as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(result).catch(() => undefined);
        }
      } catch {
        // Bootstrap observers cannot interrupt lifecycle or mandatory cleanup.
      }
    }
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

  private pluginState(name: string): ApplicationPluginState {
    const state = this.pluginStates.find((item) => item.name === name);
    if (!state) throw new Error('Application plugin state is unavailable');
    return state;
  }

  private failPluginState(name: string, errorCode: string): void {
    const state = this.pluginState(name);
    state.status = 'failed';
    state.errorCode = errorCode;
    delete state.pid;
    delete state.retryAfterMs;
  }
}

function applyProcessState(
  target: ApplicationPluginState,
  source: ApplicationPluginProcessState,
): void {
  target.status = source.status;
  target.restartCount = source.restartCount;
  setOptional(target, 'generation', source.generation);
  setOptional(target, 'pid', source.pid);
  setOptional(target, 'lastFailureAt', source.lastFailureAt);
  setOptional(target, 'retryAfterMs', source.retryAfterMs);
  setOptional(target, 'errorCode', source.error?.code ?? null);
}

function setOptional<K extends 'generation' | 'pid' | 'lastFailureAt' | 'retryAfterMs' | 'errorCode'>(
  target: ApplicationPluginState,
  key: K,
  value: ApplicationPluginState[K] | null,
): void {
  if (value === null || value === undefined) delete target[key];
  else target[key] = value;
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

function assertServerRoute(
  pluginName: string,
  location: 'server',
  methods: string[] | undefined,
): void {
  if (location !== 'server' || methods?.some((method) => method.startsWith('panel.'))) {
    throw new Error(`Application plugin "${pluginName}" can register only server message routes`);
  }
}

function createStableUnavailableError(plugin: string): Error & {
  readonly code: 'APPLICATION_PLUGIN_UNAVAILABLE';
  readonly plugin: string;
} {
  const error = Object.assign(new Error('Application plugin is unavailable'), {
    code: 'APPLICATION_PLUGIN_UNAVAILABLE' as const,
    plugin,
  });
  delete error.stack;
  return Object.freeze(error);
}

function createApplicationRuntimeUnavailableError(): Error & {
  readonly code: 'APPLICATION_RUNTIME_UNAVAILABLE';
} {
  const error = Object.assign(new Error('Application runtime is unavailable'), {
    code: 'APPLICATION_RUNTIME_UNAVAILABLE' as const,
  });
  delete error.stack;
  return Object.freeze(error);
}

function withLifecycleOperationTimeout(
  operation: Promise<void>,
  operationName: 'attach' | 'detach',
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(Object.assign(new Error(`Application plugin lifecycle ${operationName} timed out`), {
        code: 'APPLICATION_PLUGIN_LIFECYCLE_TIMEOUT' as const,
      }));
    }, LIFECYCLE_OPERATION_TIMEOUT_MS);
  });
  return Promise.race([operation, expired]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function isLifecycleOperationTimeout(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && error.code === 'APPLICATION_PLUGIN_LIFECYCLE_TIMEOUT';
}

function isApplicationRuntimeUnavailable(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && error.code === 'APPLICATION_RUNTIME_UNAVAILABLE';
}

function isApplicationPluginUnavailable(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && error.code === 'APPLICATION_PLUGIN_UNAVAILABLE';
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
