import { afterEach, describe, expect, it, vi } from 'vitest';
import { SELECTION_CHANGED_TOPIC } from '@itharbors/sqlite-contracts';

type PluginDefinition = {
  lifecycle?: { load?(runtime: unknown): void; unload?(): void };
  methods: Record<string, (...args: any[]) => any>;
};

describe('SQLite Explorer selection owner', () => {
  afterEach(() => {
    vi.resetModules();
    delete (globalThis as typeof globalThis & { editor?: unknown }).editor;
  });

  it('accepts only objects from the current core schema and broadcasts effective changes', async () => {
    let definition: PluginDefinition | undefined;
    (globalThis as typeof globalThis & { editor?: unknown }).editor = {
      plugin: { define(value: PluginDefinition) { definition = value; } },
    };
    await import('../main/src/index');

    const broadcast = vi.fn();
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getSchema') {
        return {
          connectionRevision: 2,
          schemaRevision: 4,
          dataRevision: 7,
          objects: [{ name: 'users' }, { name: 'orders' }],
        };
      }
      throw new Error(`Unexpected method: ${method}`);
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

    expect(definition!.methods.getSelection()).toEqual({
      connectionRevision: 2,
      objectName: 'users',
    });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(SELECTION_CHANGED_TOPIC, {
      connectionRevision: 2,
      objectName: 'users',
    });
  });

  it('clears selection when the connection revision changes', async () => {
    let definition: PluginDefinition | undefined;
    (globalThis as typeof globalThis & { editor?: unknown }).editor = {
      plugin: { define(value: PluginDefinition) { definition = value; } },
    };
    await import('../main/src/index');

    const broadcast = vi.fn();
    const request = vi.fn(async () => ({ connectionRevision: 1, objects: [{ name: 'users' }] }));
    definition!.lifecycle?.load?.({ message: { request, broadcast } });
    await definition!.methods.onConnectionChanged({ connectionRevision: 1 });
    await definition!.methods.selectObject({ connectionRevision: 1, objectName: 'users' });
    broadcast.mockClear();

    await definition!.methods.onConnectionChanged({ connectionRevision: 2 });

    expect(definition!.methods.getSelection()).toEqual({
      connectionRevision: 2,
      objectName: null,
    });
    expect(broadcast).toHaveBeenCalledWith(SELECTION_CHANGED_TOPIC, {
      connectionRevision: 2,
      objectName: null,
    });
  });
});
