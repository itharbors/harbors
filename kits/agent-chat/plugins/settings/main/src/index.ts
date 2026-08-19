declare const editor: any;

const DEFAULT_CONFIG_TYPES = [
  { name: 'default', priority: 0, scope: 'shared' },
  { name: 'global', priority: 10, scope: 'shared' },
  { name: 'project', priority: 20, scope: 'editor' },
];

let runtime: any = null;
let disposeConfigSubscription: (() => void) | null = null;
const knownKeys = new Set<string>();

function ensureConfigTypes(): void {
  if (!runtime) return;
  try {
    runtime.config.registerTypes(DEFAULT_CONFIG_TYPES);
  } catch {
    // types 可能已由其他插件注册，忽略重复注册错误
  }
}

function trackKey(key: string): void {
  knownKeys.add(key);
}

function handleConfigChange(event: any): void {
  if (event?.key) {
    trackKey(event.key);
  }
}

editor.plugin.define({
  lifecycle: {
    load(context: any) {
      runtime = context;
      ensureConfigTypes();
      disposeConfigSubscription = runtime.config.subscribe(handleConfigChange);
    },
    unload() {
      disposeConfigSubscription?.();
      disposeConfigSubscription = null;
      runtime = null;
      knownKeys.clear();
    },
  },
  methods: {
    getTypes() {
      // 无法直接从 config 模块读取已注册类型，返回默认类型列表
      return DEFAULT_CONFIG_TYPES.map((type) => ({ ...type }));
    },

    get(key: string, type?: string) {
      if (!runtime) throw new Error('settings plugin not loaded');
      const value = type ? runtime.config.get(key, type) : runtime.config.get(key);
      return { key, type: type ?? null, value: value ?? null };
    },

    set(key: string, value: unknown, type?: string) {
      if (!runtime) throw new Error('settings plugin not loaded');
      runtime.config.set(key, value, type);
      trackKey(key);
      return { ok: true, key };
    },

    delete(key: string, type?: string) {
      if (!runtime) throw new Error('settings plugin not loaded');
      runtime.config.delete(key, type);
      // 如果未指定类型，检查所有类型中是否还有该 key 的值
      if (!type) {
        const hasValue = DEFAULT_CONFIG_TYPES.some(
          (t) => runtime.config.get(key, t.name) !== undefined,
        );
        if (!hasValue) knownKeys.delete(key);
      }
      return { ok: true, key };
    },

    list() {
      if (!runtime) throw new Error('settings plugin not loaded');
      const entries: Array<{
        key: string;
        value: unknown;
        perType: Record<string, unknown>;
      }> = [];
      for (const key of knownKeys) {
        const perType: Record<string, unknown> = {};
        for (const type of DEFAULT_CONFIG_TYPES) {
          const v = runtime.config.get(key, type.name);
          if (v !== undefined) {
            perType[type.name] = v;
          }
        }
        entries.push({
          key,
          value: runtime.config.get(key) ?? null,
          perType,
        });
      }
      entries.sort((a, b) => a.key.localeCompare(b.key));
      return { entries };
    },

    openSettingsPanel() {
      if (!runtime) throw new Error('settings plugin not loaded');
      return runtime.window.openPanel('settings.settings');
    },
  },
});
