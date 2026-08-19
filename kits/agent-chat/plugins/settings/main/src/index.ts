import {
  buildSettingsViewModel,
  findSetting,
  SettingsSchemaError,
  type ConfigLayer,
  type SettingsProvider,
  type SettingsLayer,
  validateSettingValue,
  validateSettingsContribution,
} from './schema.js';

declare const editor: any;

const DEFAULT_CONFIG_TYPES = [
  { name: 'default', priority: 0, scope: 'shared' },
  { name: 'global', priority: 10, scope: 'shared' },
];

let runtime: any = null;
let disposeConfigSubscription: (() => void) | null = null;
const knownKeys = new Set<string>();
const providers = new Map<string, SettingsProvider>();
let suppressConfigBroadcast = false;

function trackKey(key: string): void {
  knownKeys.add(key);
}

function broadcast(topic: string, ...args: unknown[]): void {
  try {
    runtime?.message.broadcast(topic, ...args);
  } catch (error) {
    console.error(`[settings] broadcast ${topic} failed`, error);
  }
}

function handleConfigChange(event: any): void {
  if (!event?.key) return;
  trackKey(event.key);
  if (!suppressConfigBroadcast && findRegisteredField(event.key)) broadcast('settings.config.changed', event);
}

function findRegisteredField(key: string): { provider: SettingsProvider; field: ReturnType<typeof findSetting> } | undefined {
  for (const provider of providers.values()) {
    const field = findSetting(provider, key);
    if (field) return { provider, field };
  }
  return undefined;
}

function providerKeys(provider: SettingsProvider): string[] {
  return provider.sections.flatMap((section) => section.fields.map((field) => field.key));
}

function updateProviderDefaults(previous: SettingsProvider | undefined, next: SettingsProvider): void {
  const oldKeys = new Set(previous ? providerKeys(previous) : []);
  const newKeys = new Set(providerKeys(next));
  const updates = new Map<string, unknown>();
  for (const section of next.sections) {
    for (const field of section.fields) {
      updates.set(field.key, field.defaultValue);
    }
  }
  for (const key of oldKeys) {
    if (!newKeys.has(key)) updates.set(key, undefined);
  }

  const snapshot = new Map<string, unknown>();
  for (const key of updates.keys()) snapshot.set(key, runtime.config.get(key, 'default'));
  suppressConfigBroadcast = true;
  try {
    for (const [key, value] of updates) {
      if (value === undefined) runtime.config.delete(key, 'default');
      else runtime.config.set(key, value, 'default');
    }
  } catch (error) {
    for (const [key, value] of snapshot) {
      try {
        if (value === undefined) runtime.config.delete(key, 'default');
        else runtime.config.set(key, value, 'default');
      } catch (rollbackError) {
        console.error(`[settings] failed to rollback default for ${key}`, rollbackError);
      }
    }
    throw error;
  } finally {
    suppressConfigBroadcast = false;
  }
}

function registerProvider(pluginName: string, contribute: unknown): void {
  try {
    const previous = providers.get(pluginName);
    const existingKeys = [...providers.values()]
      .filter((item) => item.owner !== pluginName)
      .flatMap(providerKeys);
    const provider = validateSettingsContribution(pluginName, contribute, existingKeys);
    updateProviderDefaults(previous, provider);
    providers.set(pluginName, provider);
    for (const section of provider.sections) {
      for (const field of section.fields) {
        trackKey(field.key);
      }
    }
    broadcast('settings.registry.changed', { action: previous ? 'replace' : 'attach', owner: pluginName });
  } catch (error) {
    console.error(`[settings] ignored invalid contribution from ${pluginName}`, error);
  }
}

function unregisterProvider(pluginName: string): void {
  const provider = providers.get(pluginName);
  if (!provider) return;
  for (const section of provider.sections) {
    for (const field of section.fields) runtime?.config.delete(field.key, 'default');
  }
  providers.delete(pluginName);
  broadcast('settings.registry.changed', { action: 'detach', owner: pluginName });
}

function assertRuntime(): any {
  if (!runtime) throw new Error('settings plugin not loaded');
  return runtime;
}

function assertValueRequest(input: unknown): { key: string; layer: SettingsLayer; value?: unknown } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('settings value request must be an object');
  const value = input as Record<string, unknown>;
  if (typeof value.key !== 'string' || !value.key) throw new Error('settings value request key is required');
  if (value.layer !== 'global') throw new Error('settings value request layer must be global');
  return { key: value.key, layer: value.layer, ...(Object.prototype.hasOwnProperty.call(value, 'value') ? { value: value.value } : {}) };
}

function assertRegisteredField(key: string, layer: SettingsLayer) {
  const found = findRegisteredField(key);
  if (!found?.field) throw new Error(`unknown setting key: ${key}`);
  if (!found.field.layers.includes(layer)) throw new Error(`setting ${key} does not allow ${layer} layer`);
  return found.field;
}

function assertConfigType(type: unknown): 'default' | 'global' | undefined {
  if (type === undefined) return undefined;
  if (type !== 'default' && type !== 'global') throw new Error('settings config type must be default or global');
  return type;
}

editor.plugin.define({
  lifecycle: {
    load(context: any) {
      runtime = context;
      disposeConfigSubscription = runtime.config.subscribe(handleConfigChange);
    },
    unload() {
      disposeConfigSubscription?.();
      disposeConfigSubscription = null;
      // 配置值属于 provider，不因 Settings 宿主自身卸载而被清除。
      providers.clear();
      runtime = null;
      knownKeys.clear();
      suppressConfigBroadcast = false;
    },
    attach(pluginName: string, contribute: unknown) {
      if (!runtime || !contribute || typeof contribute !== 'object' || !('settings' in contribute)) return;
      registerProvider(pluginName, contribute);
    },
    detach(pluginName: string) {
      if (runtime) unregisterProvider(pluginName);
      else providers.delete(pluginName);
    },
  },
  methods: {
    getTypes() {
      return DEFAULT_CONFIG_TYPES.map((type) => ({ ...type }));
    },

    get(key: string, type?: string) {
      const currentRuntime = assertRuntime();
      const configType = assertConfigType(type);
      const value = configType ? currentRuntime.config.get(key, configType) : currentRuntime.config.get(key);
      return { key, type: type ?? null, value: value ?? null };
    },

    set(key: string, value: unknown, type?: string) {
      const currentRuntime = assertRuntime();
      currentRuntime.config.set(key, value, assertConfigType(type));
      trackKey(key);
      return { ok: true, key };
    },

    delete(key: string, type?: string) {
      const currentRuntime = assertRuntime();
      currentRuntime.config.delete(key, assertConfigType(type));
      if (!type && DEFAULT_CONFIG_TYPES.every((configType) => currentRuntime.config.get(key, configType.name) === undefined)) knownKeys.delete(key);
      return { ok: true, key };
    },

    list() {
      const currentRuntime = assertRuntime();
      const entries = [...knownKeys].map((key) => {
        const perType: Record<string, unknown> = {};
        for (const type of DEFAULT_CONFIG_TYPES) {
          const value = currentRuntime.config.get(key, type.name);
          if (value !== undefined) perType[type.name] = value;
        }
        return { key, value: currentRuntime.config.get(key) ?? null, perType };
      });
      entries.sort((a, b) => a.key.localeCompare(b.key));
      return { entries };
    },

    getViewModel() {
      const currentRuntime = assertRuntime();
      return buildSettingsViewModel(providers.values(), (key, layer: ConfigLayer) => currentRuntime.config.get(key, layer));
    },

    setValue(input: unknown) {
      const currentRuntime = assertRuntime();
      const request = assertValueRequest(input);
      const field = assertRegisteredField(request.key, request.layer);
      validateSettingValue(field, request.value);
      currentRuntime.config.set(request.key, request.value, request.layer);
      trackKey(request.key);
      return { ok: true, key: request.key, layer: request.layer };
    },

    resetValue(input: unknown) {
      const currentRuntime = assertRuntime();
      const request = assertValueRequest(input);
      assertRegisteredField(request.key, request.layer);
      currentRuntime.config.delete(request.key, request.layer);
      return { ok: true, key: request.key, layer: request.layer };
    },

    openSettingsPanel() {
      assertRuntime();
      return runtime.window.openPanel('settings.settings');
    },
  },
});
