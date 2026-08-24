import type {
  ConfigActivation,
  ConfigActivationTransaction,
  ConfigChangeEvent,
  ConfigLayerBackend,
  ConfigLayerDefinition,
  ConfigOwner,
  EditorConfig,
  JsonValue,
  PluginConfig,
} from './types';

export const CONFIG_NOT_ACTIVATED = 'CONFIG_NOT_ACTIVATED';
export const CONFIG_OWNER_NOT_ACTIVE = 'CONFIG_OWNER_NOT_ACTIVE';

export class ConfigNotActivatedError extends Error {
  readonly code = CONFIG_NOT_ACTIVATED;

  constructor() {
    super('Config layers are not activated');
    this.name = 'ConfigNotActivatedError';
  }
}

export class ConfigOwnerNotActiveError extends Error {
  readonly code = CONFIG_OWNER_NOT_ACTIVE;

  constructor(kitId: string) {
    super(`Config owner is not active for Kit "${kitId}"`);
    this.name = 'ConfigOwnerNotActiveError';
  }
}

export class MemoryConfigLayerBackend implements ConfigLayerBackend {
  private readonly values = new Map<string, Map<string, JsonValue>>();

  get(key: string, namespace = ''): JsonValue | undefined {
    return this.values.get(namespace)?.get(key);
  }

  set(key: string, value: JsonValue, namespace = ''): void {
    let values = this.values.get(namespace);
    if (!values) {
      values = new Map();
      this.values.set(namespace, values);
    }
    values.set(key, value);
  }

  delete(key: string, namespace = ''): void {
    const values = this.values.get(namespace);
    values?.delete(key);
    if (values?.size === 0) this.values.delete(namespace);
  }

  destroy(): void {
    this.values.clear();
  }
}

export function createMemoryConfigLayerBackend(): ConfigLayerBackend {
  return new MemoryConfigLayerBackend();
}

interface ConfigState {
  activeKitId: string | undefined;
  layers: Map<string, ConfigLayerDefinition>;
  orderedLayers: ConfigLayerDefinition[];
  writeLayer: string | undefined;
}

export class ConfigModule implements EditorConfig {
  private readonly listeners = new Set<(event: ConfigChangeEvent) => void>();
  private layers = new Map<string, ConfigLayerDefinition>();
  private orderedLayers: ConfigLayerDefinition[] = [];
  private writeLayer: string | undefined;
  private pendingActivation: ConfigActivationTransaction | undefined;
  private activeKitId: string | undefined;

  /**
   * Installs host-selected layers and returns a one-shot Kit-switch handle.
   * The new layers are active immediately; commit destroys old backends, while
   * rollback destroys new backends and restores the old layers.
   */
  activate(activation: ConfigActivation): ConfigActivationTransaction {
    const nextLayers = this.validateActivation(activation);
    if (this.pendingActivation) throw new Error('Config activation already pending');

    const previous: ConfigState = {
      activeKitId: this.activeKitId,
      layers: this.layers,
      orderedLayers: this.orderedLayers,
      writeLayer: this.writeLayer,
    };
    const next: ConfigState = {
      activeKitId: activation.kitId,
      layers: new Map(nextLayers.map((layer) => [layer.name, layer])),
      orderedLayers: [...nextLayers].sort((left, right) => right.priority - left.priority),
      writeLayer: activation.writeLayer,
    };

    this.layers = next.layers;
    this.orderedLayers = next.orderedLayers;
    this.writeLayer = next.writeLayer;
    this.activeKitId = next.activeKitId;

    let settled = false;
    const transaction: ConfigActivationTransaction = {
      commit: () => {
        if (settled) return;
        settled = true;
        this.pendingActivation = undefined;
        destroyBackendsExcept(previous.layers, next.layers);
      },
      rollback: () => {
        if (settled) return;
        settled = true;
        this.pendingActivation = undefined;
        this.layers = previous.layers;
        this.orderedLayers = previous.orderedLayers;
        this.writeLayer = previous.writeLayer;
        this.activeKitId = previous.activeKitId;
        destroyBackendsExcept(next.layers, previous.layers);
      },
    };
    this.pendingActivation = transaction;
    return transaction;
  }

  /**
   * Temporarily removes all active layers for a Kit without config layers.
   * Commit destroys the previous backends; rollback restores the previous state.
   */
  deactivate(): ConfigActivationTransaction {
    if (this.pendingActivation) throw new Error('Config activation already pending');

    const previous: ConfigState = {
      activeKitId: this.activeKitId,
      layers: this.layers,
      orderedLayers: this.orderedLayers,
      writeLayer: this.writeLayer,
    };
    const next: ConfigState = {
      activeKitId: undefined,
      layers: new Map(),
      orderedLayers: [],
      writeLayer: undefined,
    };

    this.layers = next.layers;
    this.orderedLayers = next.orderedLayers;
    this.writeLayer = next.writeLayer;
    this.activeKitId = next.activeKitId;

    let settled = false;
    const transaction: ConfigActivationTransaction = {
      commit: () => {
        if (settled) return;
        settled = true;
        this.pendingActivation = undefined;
        destroyBackends(previous.layers);
      },
      rollback: () => {
        if (settled) return;
        settled = true;
        this.pendingActivation = undefined;
        this.layers = previous.layers;
        this.orderedLayers = previous.orderedLayers;
        this.writeLayer = previous.writeLayer;
        this.activeKitId = previous.activeKitId;
      },
    };
    this.pendingActivation = transaction;
    return transaction;
  }

  get(key: string, type?: string): JsonValue | undefined {
    if (type !== undefined) return this.requireLayer(type).backend.get(key);

    this.requireActivated();
    for (const layer of this.orderedLayers) {
      const value = layer.backend.get(key);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  set(key: string, value: JsonValue, type?: string): void {
    this.assertJsonValue(value);
    const layer = this.requireLayer(type ?? this.writeLayer);
    layer.backend.set(key, value);
    this.emit({ key, type: layer.name, action: 'set' });
  }

  delete(key: string, type?: string): void {
    const layer = this.requireLayer(type ?? this.writeLayer);
    layer.backend.delete(key);
    this.emit({ key, type: layer.name, action: 'delete' });
  }

  /** Creates the only config surface that is safe to expose to a plugin. */
  bind(owner: ConfigOwner): PluginConfig {
    assertOwner(owner);
    const pluginName = owner.pluginName;
    const kitId = owner.kitId;
    const storageNamespace = kitId === '__framework__' && pluginName === 'config' ? '' : pluginName;
    return {
      get: (key, layer) => this.getScoped(kitId, storageNamespace, key, layer),
      set: (key, value, layer) => this.setScoped(kitId, storageNamespace, key, value, layer),
      delete: (key, layer) => this.deleteScoped(kitId, storageNamespace, key, layer),
      subscribe: (listener) => {
        this.requireOwnerKit(kitId);
        return this.subscribe((event) => {
          const activeForOwner = kitId === '__framework__' || this.activeKitId === kitId;
          const receivesHostEvent = pluginName === 'config' && event.pluginName === undefined;
          if (activeForOwner && (receivesHostEvent || event.pluginName === pluginName)) {
            listener({ key: event.key, type: event.type, action: event.action });
          }
        });
      },
    };
  }

  subscribe(listener: (event: ConfigChangeEvent) => void): () => void {
    this.listeners.add(listener);
    let disposed = false;

    return () => {
      if (disposed) return;
      disposed = true;
      this.listeners.delete(listener);
    };
  }

  destroy(): void {
    this.listeners.clear();
    if (this.pendingActivation) this.pendingActivation.rollback();
    const current = this.layers;
    this.layers = new Map();
    this.orderedLayers = [];
    this.writeLayer = undefined;
    this.activeKitId = undefined;
    destroyBackends(current);
  }

  private requireActivated(): void {
    if (this.layers.size === 0 || !this.writeLayer) throw new ConfigNotActivatedError();
  }

  private requireLayer(name: string | undefined): ConfigLayerDefinition {
    this.requireActivated();
    if (!name) throw new ConfigNotActivatedError();
    const layer = this.layers.get(name);
    if (!layer) throw new Error(`Unknown config layer: ${name}`);
    return layer;
  }

  private getScoped(kitId: string, pluginName: string, key: string, type?: string): JsonValue | undefined {
    this.requireOwnerKit(kitId);
    if (type !== undefined) return this.requireLayer(type).backend.get(key, pluginName);
    this.requireActivated();
    for (const layer of this.orderedLayers) {
      const value = layer.backend.get(key, pluginName);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  private setScoped(kitId: string, pluginName: string, key: string, value: JsonValue, type?: string): void {
    this.requireOwnerKit(kitId);
    this.assertJsonValue(value);
    const layer = this.requireLayer(type ?? this.writeLayer);
    layer.backend.set(key, value, pluginName);
    this.emit({ key, type: layer.name, action: 'set', pluginName });
  }

  private deleteScoped(kitId: string, pluginName: string, key: string, type?: string): void {
    this.requireOwnerKit(kitId);
    const layer = this.requireLayer(type ?? this.writeLayer);
    layer.backend.delete(key, pluginName);
    this.emit({ key, type: layer.name, action: 'delete', pluginName });
  }

  private validateActivation(activation: ConfigActivation): ConfigLayerDefinition[] {
    if (!activation || !Array.isArray(activation.layers) || activation.layers.length === 0) {
      throw new Error('Config layers must not be empty');
    }
    if (typeof activation.writeLayer !== 'string' || activation.writeLayer.length === 0) {
      throw new Error('Config writeLayer must be a non-empty string');
    }
    if (activation.kitId !== undefined && (typeof activation.kitId !== 'string' || activation.kitId.length === 0)) {
      throw new Error('Config kitId must be a non-empty string');
    }

    const names = new Set<string>();
    const priorities = new Set<number>();
    const layers = activation.layers.map((layer, index) => {
      if (!layer || typeof layer !== 'object') throw new Error(`Config layer ${index} must be an object`);
      if (typeof layer.name !== 'string' || layer.name.length === 0) {
        throw new Error(`Config layer ${index} name must be a non-empty string`);
      }
      if (names.has(layer.name)) throw new Error(`Duplicate config layer: ${layer.name}`);
      if (!Number.isFinite(layer.priority)) throw new Error(`Invalid config priority for layer: ${layer.name}`);
      if (priorities.has(layer.priority)) throw new Error(`Duplicate config priority: ${String(layer.priority)}`);
      if (!layer.backend || typeof layer.backend !== 'object'
        || typeof layer.backend.get !== 'function'
        || typeof layer.backend.set !== 'function'
        || typeof layer.backend.delete !== 'function'
        || (layer.backend.destroy !== undefined && typeof layer.backend.destroy !== 'function')) {
        throw new Error(`Invalid config backend for layer: ${layer.name}`);
      }
      names.add(layer.name);
      priorities.add(layer.priority);
      return layer;
    });
    if (!names.has(activation.writeLayer)) {
      throw new Error(`Config writeLayer does not exist: ${activation.writeLayer}`);
    }
    return layers;
  }

  private requireOwnerKit(kitId: string): void {
    // The built-in config service is host-owned and follows the active Kit.
    if (kitId === '__framework__') return;
    this.requireActivated();
    if (this.activeKitId !== kitId) throw new ConfigOwnerNotActiveError(kitId);
  }

  private emit(event: ConfigChangeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private assertJsonValue(value: JsonValue): void {
    if (!this.isJsonValue(value)) throw new Error('Config value must be JSON-serializable');
  }

  private isJsonValue(value: unknown): value is JsonValue {
    if (
      value === null
      || typeof value === 'string'
      || (typeof value === 'number' && Number.isFinite(value))
      || typeof value === 'boolean'
    ) return true;
    if (Array.isArray(value)) return value.every((item) => this.isJsonValue(item));
    if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
    return Object.values(value).every((item) => this.isJsonValue(item));
  }
}

function assertOwner(owner: ConfigOwner): void {
  if (!owner || typeof owner.kitId !== 'string' || owner.kitId.length === 0
    || typeof owner.pluginName !== 'string' || owner.pluginName.length === 0) {
    throw new Error('Config owner must contain non-empty kitId and pluginName');
  }
}

function destroyBackends(layers: Map<string, ConfigLayerDefinition>): void {
  const backends = new Set([...layers.values()].map((layer) => layer.backend));
  for (const backend of backends) backend.destroy?.();
}

function destroyBackendsExcept(
  source: Map<string, ConfigLayerDefinition>,
  keep: Map<string, ConfigLayerDefinition>,
): void {
  const keepBackends = new Set([...keep.values()].map((layer) => layer.backend));
  const sourceBackends = new Set([...source.values()].map((layer) => layer.backend));
  for (const backend of sourceBackends) {
    if (!keepBackends.has(backend)) backend.destroy?.();
  }
}

export * from './types';
