import type { I18nChangeEvent, I18nVisibleSnapshot } from '../core/session';

interface I18nStore {
  hydrate(snapshot: I18nVisibleSnapshot): void;
  replaceVisibleSnapshot(snapshot: I18nVisibleSnapshot, event?: I18nChangeEvent): void;
  t(key: string, params?: Record<string, unknown>): string;
  getSnapshot(): I18nVisibleSnapshot | null;
  subscribe(listener: (event: I18nChangeEvent) => void): () => void;
}

export function createI18nStore(): I18nStore {
  const storeState = {
    snapshot: null as I18nVisibleSnapshot | null,
    listeners: new Set<(event: I18nChangeEvent) => void>(),
  };

  return {
    hydrate(snapshot) {
      storeState.snapshot = snapshot;
    },
    replaceVisibleSnapshot(snapshot, event) {
      storeState.snapshot = snapshot;
      if (!event) return;
      for (const listener of storeState.listeners) {
        listener(event);
      }
    },
    t(key, params = {}) {
      const snapshot = storeState.snapshot;
      const raw = snapshot?.currentMessages[key] ?? snapshot?.defaultMessages[key] ?? key;
      return raw.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
    },
    getSnapshot() {
      return storeState.snapshot;
    },
    subscribe(listener) {
      storeState.listeners.add(listener);
      return () => {
        storeState.listeners.delete(listener);
      };
    },
  };
}

export const i18nStore = createI18nStore();
