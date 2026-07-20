import { afterEach, describe, expect, it, vi } from 'vitest';
import { SELECTION_CHANGED_TOPIC } from '@itharbors/mysql-contracts';

type PluginDefinition = {
  lifecycle?: { load?(runtime: unknown): void; unload?(): void };
  methods: Record<string, (...args: any[]) => any>;
};

describe('MySQL Explorer selection owner', () => {
  afterEach(() => {
    vi.resetModules();
    delete (globalThis as typeof globalThis & { editor?: unknown }).editor;
  });

  it('accepts only current schema objects and broadcasts effective changes', async () => {
    let definition: PluginDefinition | undefined;
    (globalThis as typeof globalThis & { editor?: unknown }).editor = {
      plugin: { define(value: PluginDefinition) { definition = value; } },
    };
    await import('../main/src/index');

    const broadcast = vi.fn();
    const request = vi.fn(async (plugin: string, method: string) => {
      expect(plugin).toBe('@itharbors/mysql-core');
      expect(method).toBe('getSchema');
      return {
        connectionRevision: 2,
        schemaRevision: 4,
        dataRevision: 7,
        objects: [{ name: 'users' }, { name: 'active_users' }],
      };
    });
    definition!.lifecycle?.load?.({ message: { request, broadcast } });
    await definition!.methods.onConnectionChanged({ connectionRevision: 2 });
    broadcast.mockClear();

    await expect(definition!.methods.selectObject({
      connectionRevision: 1,
      objectName: 'users',
    })).rejects.toThrow(/连接已变化/);
    await expect(definition!.methods.selectObject({
      connectionRevision: 2,
      objectName: 'missing',
    })).rejects.toThrow(/对象不存在/);
    await expect(definition!.methods.selectObject({
      connectionRevision: 2,
      objectName: 'users',
    })).resolves.toEqual({ connectionRevision: 2, objectName: 'users' });
    await definition!.methods.selectObject({ connectionRevision: 2, objectName: 'users' });

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(SELECTION_CHANGED_TOPIC, {
      connectionRevision: 2,
      objectName: 'users',
    });
  });

  it('clears selection when connection changes or the selected object disappears', async () => {
    let definition: PluginDefinition | undefined;
    (globalThis as typeof globalThis & { editor?: unknown }).editor = {
      plugin: { define(value: PluginDefinition) { definition = value; } },
    };
    await import('../main/src/index');

    let objects = [{ name: 'users' }];
    const broadcast = vi.fn();
    const request = vi.fn(async () => ({
      connectionRevision: 1,
      schemaRevision: 2,
      dataRevision: 3,
      objects,
    }));
    definition!.lifecycle?.load?.({ message: { request, broadcast } });
    await definition!.methods.onConnectionChanged({ connectionRevision: 1 });
    await definition!.methods.selectObject({ connectionRevision: 1, objectName: 'users' });
    objects = [];
    await definition!.methods.onSchemaChanged({ connectionRevision: 1 });

    expect(definition!.methods.getSelection()).toEqual({
      connectionRevision: 1,
      objectName: null,
    });

    await definition!.methods.onConnectionChanged({ connectionRevision: 2 });
    expect(definition!.methods.getSelection()).toEqual({
      connectionRevision: 2,
      objectName: null,
    });
  });
});
