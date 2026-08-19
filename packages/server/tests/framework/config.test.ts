import { describe, expect, it, vi } from 'vitest';
import {
  ConfigModule,
  ConfigNotActivatedError,
  MemoryConfigLayerBackend,
} from '../../src/framework/config';
import type { ConfigLayerBackend, JsonValue } from '../../src/framework/config';

class TestBackend implements ConfigLayerBackend {
  private readonly values = new Map<string, Map<string, JsonValue>>();
  readonly destroy = vi.fn(() => this.values.clear());

  get(key: string, namespace = ''): JsonValue | undefined {
    return this.values.get(namespace)?.get(key);
  }

  set(key: string, value: JsonValue, namespace = ''): void {
    let values = this.values.get(namespace);
    if (!values) {
      values = new Map();
      this.values.set(namespace, values);
    }
    values.set(key, value);
  }

  delete(key: string, namespace = ''): void {
    const values = this.values.get(namespace);
    values?.delete(key);
    if (values?.size === 0) this.values.delete(namespace);
  }
}

function activate(
  config: ConfigModule,
  layers: Array<{ name: string; priority: number; backend?: ConfigLayerBackend }> = [
    { name: 'default', priority: 0 },
    { name: 'global', priority: 10 },
    { name: 'project', priority: 20 },
  ],
  writeLayer = 'project',
  kitId = 'kit-a',
) {
  return config.activate({
    kitId,
    layers: layers.map((layer) => ({
      ...layer,
      backend: layer.backend ?? new TestBackend(),
    })),
    writeLayer,
  });
}

describe('ConfigModule', () => {
  it('fails closed before host activation', () => {
    const config = new ConfigModule();

    expect(() => config.get('theme')).toThrow(ConfigNotActivatedError);
    expect(() => config.get('theme', 'global')).toThrow(ConfigNotActivatedError);
    expect(() => config.set('theme', 'dark')).toThrow(ConfigNotActivatedError);
    expect(() => config.delete('theme')).toThrow(ConfigNotActivatedError);
  });

  it('rejects non-finite numbers as configuration values', () => {
    const config = new ConfigModule();
    activate(config).commit();

    expect(() => config.set('nan', Number.NaN)).toThrow(/JSON-serializable/u);
    expect(() => config.set('infinity', Number.POSITIVE_INFINITY)).toThrow(/JSON-serializable/u);
    expect(() => config.set('nested', { value: Number.NEGATIVE_INFINITY })).toThrow(/JSON-serializable/u);
  });

  it('resolves high-priority values and writes implicit operations to writeLayer', () => {
    const config = new ConfigModule();
    const transaction = activate(config);
    transaction.commit();

    config.set('theme', 'light', 'default');
    config.set('theme', 'dark', 'global');

    expect(config.get('theme')).toBe('dark');
    expect(config.get('theme', 'project')).toBeUndefined();

    config.set('theme', 'project-value');
    expect(config.get('theme')).toBe('project-value');
    config.delete('theme');
    expect(config.get('theme')).toBe('dark');
  });

  it('treats null as a value and delete as fallback', () => {
    const config = new ConfigModule();
    const transaction = activate(config);
    transaction.commit();

    config.set('flag', true, 'default');
    config.set('flag', null, 'project');
    expect(config.get('flag')).toBeNull();

    config.delete('flag', 'project');
    expect(config.get('flag')).toBe(true);
  });

  it('can share an injected backend between ConfigModules', () => {
    const backend = new TestBackend();
    const left = new ConfigModule();
    const right = new ConfigModule();
    activate(left, [{ name: 'global', priority: 10, backend }], 'global').commit();
    activate(right, [{ name: 'global', priority: 10, backend }], 'global').commit();

    left.set('theme', 'dark');
    expect(right.get('theme')).toBe('dark');
  });

  it('emits key, type and action without exposing scope', () => {
    const config = new ConfigModule();
    activate(config).commit();
    const listener = vi.fn();
    const dispose = config.subscribe(listener);

    config.set('theme', 'dark', 'project');
    config.delete('theme', 'project');

    expect(listener).toHaveBeenNthCalledWith(1, {
      key: 'theme',
      type: 'project',
      action: 'set',
    });
    expect(listener).toHaveBeenNthCalledWith(2, {
      key: 'theme',
      type: 'project',
      action: 'delete',
    });

    dispose();
    dispose();
    config.set('theme', 'light', 'project');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('isolates plugin config values and subscriptions, without exposing owner rebinding', () => {
    const config = new ConfigModule();
    activate(config, [{ name: 'global', priority: 10 }], 'global').commit();
    const first = config.bind({ kitId: 'kit-a', pluginName: 'plugin-a' });
    const second = config.bind({ kitId: 'kit-a', pluginName: 'plugin-b' });
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    first.subscribe(firstListener);
    second.subscribe(secondListener);

    first.set('shared', 'a');
    second.set('shared', 'b');

    expect(first.get('shared')).toBe('a');
    expect(second.get('shared')).toBe('b');
    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(secondListener).toHaveBeenCalledTimes(1);
    expect(Object.keys(first).sort()).toEqual(['delete', 'get', 'set', 'subscribe']);
    expect((first as unknown as { bind?: unknown }).bind).toBeUndefined();
    expect(() => (first as unknown as { set(key: string, value: JsonValue, owner: string): void })
      .set('shared', 'forged', 'plugin-b')).toThrow(/Unknown config layer/u);
    expect(second.get('shared')).toBe('b');
  });

  it('invalidates a bound facade after switching to another Kit', () => {
    const config = new ConfigModule();
    activate(config, [{ name: 'global', priority: 10 }], 'global', 'kit-a').commit();
    const bound = config.bind({ kitId: 'kit-a', pluginName: 'plugin-a' });
    bound.set('key', 'old');

    activate(config, [{ name: 'global', priority: 10 }], 'global', 'kit-b').commit();

    expect(() => bound.get('key')).toThrow(/not active/u);
    expect(() => bound.set('key', 'stale')).toThrow(/not active/u);
    expect(() => bound.delete('key')).toThrow(/not active/u);
    expect(() => bound.subscribe(() => undefined)).toThrow(/not active/u);
  });

  it('does not deliver a previous Kit listener to a same-named plugin in the next Kit', () => {
    const config = new ConfigModule();
    activate(config, [{ name: 'global', priority: 10 }], 'global', 'kit-a').commit();
    const previous = config.bind({ kitId: 'kit-a', pluginName: 'model-service' });
    const previousListener = vi.fn();
    previous.subscribe(previousListener);

    activate(config, [{ name: 'global', priority: 10 }], 'global', 'kit-b').commit();
    const current = config.bind({ kitId: 'kit-b', pluginName: 'model-service' });
    const currentListener = vi.fn();
    current.subscribe(currentListener);
    current.set('provider', 'kit-b');

    expect(previousListener).not.toHaveBeenCalled();
    expect(currentListener).toHaveBeenCalledWith({
      key: 'provider',
      type: 'global',
      action: 'set',
    });
  });

  it('validates activation without changing the active configuration', () => {
    const config = new ConfigModule();
    activate(config, [{ name: 'global', priority: 10 }], 'global').commit();
    config.set('theme', 'dark');

    expect(() => config.activate({ layers: [], writeLayer: 'global' })).toThrow(/must not be empty/u);
    expect(() => config.activate({
      layers: [
        { name: 'global', priority: 1, backend: new TestBackend() },
        { name: 'global', priority: 2, backend: new TestBackend() },
      ],
      writeLayer: 'global',
    })).toThrow(/Duplicate config layer/u);
    expect(() => config.activate({
      layers: [
        { name: 'a', priority: 1, backend: new TestBackend() },
        { name: 'b', priority: 1, backend: new TestBackend() },
      ],
      writeLayer: 'a',
    })).toThrow(/Duplicate config priority/u);
    expect(() => config.activate({
      layers: [{ name: 'a', priority: 1, backend: new TestBackend() }],
      writeLayer: 'missing',
    })).toThrow(/writeLayer does not exist/u);
    expect(() => config.activate({
      layers: [{ name: 'a', priority: 1, backend: {} as ConfigLayerBackend }],
      writeLayer: 'a',
    })).toThrow(/Invalid config backend/u);

    expect(config.get('theme')).toBe('dark');
  });

  it('commits a Kit replacement and destroys old backends', () => {
    const config = new ConfigModule();
    const oldBackend = new TestBackend();
    activate(config, [{ name: 'old', priority: 10, backend: oldBackend }], 'old').commit();
    config.set('theme', 'old');

    const newBackend = new TestBackend();
    const transaction = activate(config, [{ name: 'new', priority: 10, backend: newBackend }], 'new');
    expect(config.get('theme')).toBeUndefined();
    transaction.commit();

    expect(oldBackend.destroy).toHaveBeenCalledTimes(1);
    expect(newBackend.destroy).not.toHaveBeenCalled();
  });

  it('rolls back a Kit replacement and destroys new backends', () => {
    const config = new ConfigModule();
    const oldBackend = new TestBackend();
    activate(config, [{ name: 'old', priority: 10, backend: oldBackend }], 'old').commit();
    config.set('theme', 'old');

    const newBackend = new TestBackend();
    const transaction = activate(config, [{ name: 'new', priority: 10, backend: newBackend }], 'new');
    expect(config.get('theme')).toBeUndefined();
    transaction.rollback();

    expect(config.get('theme')).toBe('old');
    expect(oldBackend.destroy).not.toHaveBeenCalled();
    expect(newBackend.destroy).toHaveBeenCalledTimes(1);
  });

  it('deactivates config layers for a Kit without config and destroys them on commit', () => {
    const config = new ConfigModule();
    const backend = new TestBackend();
    activate(config, [{ name: 'global', priority: 10, backend }], 'global').commit();
    config.set('theme', 'old');

    const transaction = config.deactivate();
    expect(() => config.get('theme')).toThrow(ConfigNotActivatedError);
    transaction.commit();

    expect(backend.destroy).toHaveBeenCalledTimes(1);
    expect(() => config.set('theme', 'new')).toThrow(ConfigNotActivatedError);
  });

  it('rolls back deactivation and restores the previous config layers', () => {
    const config = new ConfigModule();
    const backend = new TestBackend();
    activate(config, [{ name: 'global', priority: 10, backend }], 'global').commit();
    config.set('theme', 'old');

    const transaction = config.deactivate();
    expect(() => config.get('theme')).toThrow(ConfigNotActivatedError);
    transaction.rollback();

    expect(config.get('theme')).toBe('old');
    expect(backend.destroy).not.toHaveBeenCalled();
  });

  it('destroys active and pending layers and clears listeners', () => {
    const config = new ConfigModule();
    const oldBackend = new TestBackend();
    activate(config, [{ name: 'old', priority: 10, backend: oldBackend }], 'old').commit();
    const newBackend = new TestBackend();
    activate(config, [{ name: 'new', priority: 10, backend: newBackend }], 'new');
    const listener = vi.fn();
    config.subscribe(listener);

    config.destroy();
    config.destroy();

    expect(oldBackend.destroy).toHaveBeenCalledTimes(1);
    expect(newBackend.destroy).toHaveBeenCalledTimes(1);
    expect(() => config.get('theme')).toThrow(ConfigNotActivatedError);
  });

  it('provides an in-memory layer backend', () => {
    const backend = new MemoryConfigLayerBackend();
    backend.set('theme', 'dark');
    expect(backend.get('theme')).toBe('dark');
    backend.delete('theme');
    expect(backend.get('theme')).toBeUndefined();
    backend.set('theme', 'dark');
    backend.destroy();
    expect(backend.get('theme')).toBeUndefined();
  });
});
