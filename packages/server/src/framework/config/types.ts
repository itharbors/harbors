export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ConfigLayerBackend {
  /** The namespace is host-only; it is never part of the plugin API. */
  get(key: string, namespace?: string): JsonValue | undefined;
  set(key: string, value: JsonValue, namespace?: string): void;
  delete(key: string, namespace?: string): void;
  destroy?(): void;
}

export interface ConfigLayerDefinition {
  name: string;
  priority: number;
  backend: ConfigLayerBackend;
}

export interface ConfigActivation {
  /** Host-selected Kit identity for the active layer set. */
  kitId?: string;
  layers: readonly ConfigLayerDefinition[];
  writeLayer: string;
}

export interface ConfigActivationTransaction {
  commit(): void;
  rollback(): void;
}

export interface ConfigChangeEvent {
  key: string;
  type: string;
  action: 'set' | 'delete';
  pluginName?: string;
}

export interface PluginConfig {
  get(key: string, layer?: string): JsonValue | undefined;
  set(key: string, value: JsonValue, layer?: string): void;
  delete(key: string, layer?: string): void;
  subscribe(listener: (event: ConfigChangeEvent) => void): () => void;
}

export interface ConfigOwner {
  kitId: string;
  pluginName: string;
}

export interface EditorConfig {
  get(key: string, type?: string): JsonValue | undefined;
  set(key: string, value: JsonValue, type?: string): void;
  delete(key: string, type?: string): void;
  subscribe(listener: (event: ConfigChangeEvent) => void): () => void;
}
