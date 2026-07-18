import { describe, expect, it } from 'vitest';
import { createWindowLayoutStorage } from '../../src/layout/storage';

function createMemoryStorage(): Storage {
  const backing = new Map<string, string>();
  return {
    get length() {
      return backing.size;
    },
    clear: () => backing.clear(),
    getItem: (key: string) => backing.get(key) ?? null,
    key: (index: number) => Array.from(backing.keys())[index] ?? null,
    removeItem: (key: string) => void backing.delete(key),
    setItem: (key: string, value: string) => void backing.set(key, value),
  };
}

describe('window-local layout storage', () => {
  it('scopes saved layout by client window id as well as kit/window id', () => {
    const localStorage = createMemoryStorage();
    const a = createWindowLayoutStorage({
      localStorage,
      sessionStorage: new Map([['itharbors:client-window-id', 'a']]),
    });
    const b = createWindowLayoutStorage({
      localStorage,
      sessionStorage: new Map([['itharbors:client-window-id', 'b']]),
    });

    a.save('default', 'main', 'sig-1', { kind: 'group', tabs: [] });

    expect(a.load('default', 'main', 'sig-1')).not.toBeNull();
    expect(b.load('default', 'main', 'sig-1')).toBeNull();
  });

  it('removes stale layout when default signature changes', () => {
    const localStorage = createMemoryStorage();
    const storage = createWindowLayoutStorage({
      localStorage,
      sessionStorage: new Map([['itharbors:client-window-id', 'a']]),
    });

    storage.save('default', 'main', 'sig-1', { kind: 'group', tabs: [] });

    expect(storage.load('default', 'main', 'sig-2')).toBeNull();
    expect(storage.load('default', 'main', 'sig-1')).toBeNull();
  });
});
