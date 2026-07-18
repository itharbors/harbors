export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ConfigScope = 'shared' | 'editor';

export interface ConfigTypeDefinition {
  name: string;
  priority: number;
  scope: ConfigScope;
}

export interface ConfigChangeEvent {
  key: string;
  type: string;
  scope: ConfigScope;
  action: 'set' | 'delete';
}

export interface EditorConfig {
  registerTypes(types: ConfigTypeDefinition[]): void;
  get(key: string, type?: string): JsonValue | undefined;
  set(key: string, value: JsonValue, type?: string): void;
  delete(key: string, type?: string): void;
  subscribe(listener: (event: ConfigChangeEvent) => void): () => void;
}

export type ConfigLayerStore = Map<string, Map<string, JsonValue>>;

export interface ConfigStores {
  sharedStore: ConfigLayerStore;
  editorStore: ConfigLayerStore;
}
