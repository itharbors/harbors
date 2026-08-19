import type {
  ConfigActivation,
  ConfigActivationTransaction,
  ConfigChangeEvent,
  ConfigLayerBackend,
  ConfigLayerDefinition,
  EditorConfig,
  JsonValue,
} from './types';

export const CONFIG_NOT_ACTIVATED = 'CONFIG_NOT_ACTIVATED';

export class ConfigNotActivatedError extends Error {
  readonly code = CONFIG_NOT_ACTIVATED;

  constructor() {
    super('Config layers are not activated');
    this.name = 'ConfigNotActivatedError';
  }
}

export class MemoryConfigLayerBackend implements ConfigLayerBackend {
  private readonly values = new Map<string, JsonValue>();

  get(key: string): JsonValue | undefined {
    return this.values.get(key);
  }

  set(key: string, value: JsonValue): void {
    this.values.set(key, value);
  }

  delete(key: string): void {
    this.values.delete(key);
  }

  destroy(): void {
    this.values.clear();
  }
}

export function createMemoryConfigLayerBackend(): ConfigLayerBackend {
  return new MemoryConfigLayerBackend();
}

interface ConfigState {
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

  /**
   * Installs host-selected layers and returns a one-shot Kit-switch handle.
   * The new layers are active immediately; commit destroys old backends, while
   * rollback destroys new backends and restores the old layers.
   */
  activate(activation: ConfigActivation): ConfigActivationTransaction {
    const nextLayers = this.validateActivation(activation);
    if (this.pendingActivation) throw new Error('Config activation already pending');

    const previous: ConfigState = {
      layers: this.layers,
      orderedLayers: this.orderedLayers,
      writeLayer: this.writeLayer,
    };
    const next: ConfigState = {
      layers: new Map(nextLayers.map((layer) => [layer.name, layer])),
      orderedLayers: [...nextLayers].sort((left, right) => right.priority - left.priority),
      writeLayer: activation.writeLayer,
    };

    this.layers = next.layers;
    this.orderedLayers = next.orderedLayers;
    this.writeLayer = next.writeLayer;

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
      layers: this.layers,
      orderedLayers: this.orderedLayers,
      writeLayer: this.writeLayer,
    };
    const next: ConfigState = {
      layers: new Map(),
      orderedLayers: [],
      writeLayer: undefined,
    };

    this.layers = next.layers;
    this.orderedLayers = next.orderedLayers;
    this.writeLayer = next.writeLayer;

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

  private validateActivation(activation: ConfigActivation): ConfigLayerDefinition[] {
    if (!activation || !Array.isArray(activation.layers) || activation.layers.length === 0) {
      throw new Error('Config layers must not be empty');
    }
    if (typeof activation.writeLayer !== 'string' || activation.writeLayer.length === 0) {
      throw new Error('Config writeLayer must be a non-empty string');
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
