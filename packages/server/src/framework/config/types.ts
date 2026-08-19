export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ConfigLayerBackend {
  get(key: string): JsonValue | undefined;
  set(key: string, value: JsonValue): void;
  delete(key: string): void;
  destroy?(): void;
}

export interface ConfigLayerDefinition {
  name: string;
  priority: number;
  backend: ConfigLayerBackend;
}

export interface ConfigActivation {
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
}

export interface EditorConfig {
  get(key: string, type?: string): JsonValue | undefined;
  set(key: string, value: JsonValue, type?: string): void;
  delete(key: string, type?: string): void;
  subscribe(listener: (event: ConfigChangeEvent) => void): () => void;
}
