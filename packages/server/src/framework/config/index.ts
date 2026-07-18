import type {
  ConfigChangeEvent,
  ConfigLayerStore,
  ConfigStores,
  ConfigTypeDefinition,
  EditorConfig,
  JsonValue,
} from './types';

interface ConfigModuleOptions extends Partial<ConfigStores> {}

export class ConfigModule implements EditorConfig {
  private readonly sharedStore: ConfigLayerStore;
  private readonly editorStore: ConfigLayerStore;
  private readonly listeners = new Set<(event: ConfigChangeEvent) => void>();
  private orderedTypes: ConfigTypeDefinition[] | null = null;
  private readonly typesByName = new Map<string, ConfigTypeDefinition>();

  constructor(options: ConfigModuleOptions = {}) {
    this.sharedStore = options.sharedStore ?? new Map();
    this.editorStore = options.editorStore ?? new Map();
  }

  registerTypes(types: ConfigTypeDefinition[]): void {
    if (this.orderedTypes) {
      throw new Error('Config types already registered');
    }
    if (types.length === 0) {
      throw new Error('Config types must not be empty');
    }

    const seen = new Set<string>();
    for (const type of types) {
      if (!type.name) {
        throw new Error('Config type name must not be empty');
      }
      if (seen.has(type.name)) {
        throw new Error(`Duplicate config type: ${type.name}`);
      }
      if (type.scope !== 'shared' && type.scope !== 'editor') {
        throw new Error(`Invalid config scope: ${String(type.scope)}`);
      }
      if (!Number.isFinite(type.priority)) {
        throw new Error(`Invalid config priority for type: ${type.name}`);
      }
      seen.add(type.name);
      this.typesByName.set(type.name, type);
    }

    this.orderedTypes = [...types].sort((a, b) => b.priority - a.priority);
  }

  get(key: string, type?: string): JsonValue | undefined {
    if (type) {
      const definition = this.getType(type);
      return this.getLayer(definition).get(key);
    }

    for (const definition of this.getOrderedTypes()) {
      const value = this.getLayer(definition).get(key);
      if (value !== undefined) {
        return value;
      }
    }

    return undefined;
  }

  set(key: string, value: JsonValue, type?: string): void {
    this.assertJsonValue(value);
    const definition = type ? this.getType(type) : this.getHighestPriorityType();
    this.getLayer(definition).set(key, value);
    this.emit({ key, type: definition.name, scope: definition.scope, action: 'set' });
  }

  delete(key: string, type?: string): void {
    const definition = type ? this.getType(type) : this.getHighestPriorityType();
    this.getLayer(definition).delete(key);
    this.emit({ key, type: definition.name, scope: definition.scope, action: 'delete' });
  }

  subscribe(listener: (event: ConfigChangeEvent) => void): () => void {
    this.listeners.add(listener);
    let disposed = false;

    return () => {
      if (disposed) {
        return;
      }
      disposed = true;
      this.listeners.delete(listener);
    };
  }

  destroy(): void {
    this.listeners.clear();
    this.editorStore.clear();
    this.typesByName.clear();
    this.orderedTypes = null;
  }

  private getOrderedTypes(): ConfigTypeDefinition[] {
    if (!this.orderedTypes) {
      throw new Error('Config types not registered');
    }
    return this.orderedTypes;
  }

  private getHighestPriorityType(): ConfigTypeDefinition {
    return this.getOrderedTypes()[0];
  }

  private getType(name: string): ConfigTypeDefinition {
    this.getOrderedTypes();
    const type = this.typesByName.get(name);
    if (!type) {
      throw new Error(`Unknown config type: ${name}`);
    }
    return type;
  }

  private getLayer(type: ConfigTypeDefinition): Map<string, JsonValue> {
    const store = type.scope === 'shared' ? this.sharedStore : this.editorStore;
    let layer = store.get(type.name);
    if (!layer) {
      layer = new Map<string, JsonValue>();
      store.set(type.name, layer);
    }
    return layer;
  }

  private emit(event: ConfigChangeEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private assertJsonValue(value: JsonValue): void {
    if (!this.isJsonValue(value)) {
      throw new Error('Config value must be JSON-serializable');
    }
  }

  private isJsonValue(value: unknown): value is JsonValue {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      return true;
    }

    if (Array.isArray(value)) {
      return value.every((item) => this.isJsonValue(item));
    }

    if (typeof value !== 'object') {
      return false;
    }

    if (Object.getPrototypeOf(value) !== Object.prototype) {
      return false;
    }

    return Object.values(value).every((item) => this.isJsonValue(item));
  }
}

export * from './types';
