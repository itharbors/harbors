import { afterEach, describe, expect, it, vi } from 'vitest';

type PluginDefinition = {
  lifecycle?: {
    unload?(): Promise<void>;
  };
  methods: Record<string, (...args: unknown[]) => unknown>;
};

describe('MySQL plugin main', () => {
  afterEach(() => {
    vi.resetModules();
    delete (globalThis as typeof globalThis & { editor?: unknown }).editor;
  });

  it('exposes the manifest methods and unloads idempotently', async () => {
    let definition: PluginDefinition | undefined;
    (globalThis as typeof globalThis & { editor?: unknown }).editor = {
      plugin: {
        define(value: PluginDefinition) {
          definition = value;
        },
      },
    };

    await import('../main/src/index');

    expect(Object.keys(definition!.methods).sort()).toEqual([
      'connect',
      'deleteRow',
      'disconnect',
      'executeSql',
      'getConnectionState',
      'getObjectSchema',
      'getRows',
      'getSchema',
      'insertRow',
      'updateRow',
    ]);
    await definition!.lifecycle?.unload?.();
    await definition!.lifecycle?.unload?.();
    expect(await definition!.methods.getConnectionState()).toEqual({
      connected: false,
      endpoint: null,
      database: null,
      mysqlVersion: null,
      tls: false,
    });
  });
});
