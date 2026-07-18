const CLIENT_WINDOW_KEY = 'itharbors:client-window-id';
const LAYOUT_CACHE_PREFIX = 'itharbors:layout:v1';
const LAYOUT_CACHE_VERSION = 1;

type SessionStorageLike = Pick<Storage, 'getItem' | 'setItem'> | Map<string, string>;

interface CachedLayout<T> {
  version: number;
  defaultSignature: string;
  layout: T;
}

export interface WindowLayoutStorage {
  load<T>(kitName: string, windowId: string, defaultSignature: string): T | null;
  save(kitName: string, windowId: string, defaultSignature: string, layout: unknown): void;
}

export function createWindowLayoutStorage(input: {
  localStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  sessionStorage: SessionStorageLike;
}): WindowLayoutStorage {
  const clientWindowId = ensureClientWindowId(input.sessionStorage);

  return {
    load<T>(kitName: string, windowId: string, defaultSignature: string): T | null {
      const key = createLayoutCacheKey(clientWindowId, kitName, windowId);
      try {
        const raw = input.localStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<CachedLayout<T>>;
        if (
          parsed.version !== LAYOUT_CACHE_VERSION
          || parsed.defaultSignature !== defaultSignature
          || !parsed.layout
        ) {
          input.localStorage.removeItem(key);
          return null;
        }
        return parsed.layout;
      } catch {
        input.localStorage.removeItem(key);
        return null;
      }
    },
    save(kitName: string, windowId: string, defaultSignature: string, layout: unknown): void {
      const key = createLayoutCacheKey(clientWindowId, kitName, windowId);
      input.localStorage.setItem(key, JSON.stringify({
        version: LAYOUT_CACHE_VERSION,
        defaultSignature,
        layout,
      }));
    },
  };
}

function createLayoutCacheKey(clientWindowId: string, kitName: string, windowId: string): string {
  return [
    LAYOUT_CACHE_PREFIX,
    encodeURIComponent(clientWindowId),
    encodeURIComponent(kitName),
    encodeURIComponent(windowId),
  ].join(':');
}

function ensureClientWindowId(sessionStorage: SessionStorageLike): string {
  const existing = readSessionValue(sessionStorage, CLIENT_WINDOW_KEY);
  if (existing) return existing;
  const created = createId();
  writeSessionValue(sessionStorage, CLIENT_WINDOW_KEY, created);
  return created;
}

function readSessionValue(storage: SessionStorageLike, key: string): string | null {
  if (storage instanceof Map) {
    return storage.get(key) ?? null;
  }
  return storage.getItem(key);
}

function writeSessionValue(storage: SessionStorageLike, key: string, value: string): void {
  if (storage instanceof Map) {
    storage.set(key, value);
    return;
  }
  storage.setItem(key, value);
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `window-${Date.now().toString(36)}`;
}
