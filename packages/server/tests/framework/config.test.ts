import { describe, expect, it, vi } from 'vitest';
import { ConfigModule } from '../../src/framework/config';

const TYPES = [
  { name: 'default', priority: 0, scope: 'shared' },
  { name: 'global', priority: 10, scope: 'shared' },
  { name: 'project', priority: 20, scope: 'editor' },
] as const;

describe('ConfigModule', () => {
  it('falls back from high priority to low priority', () => {
    const config = new ConfigModule();
    config.registerTypes([...TYPES]);

    config.set('theme', 'light', 'default');
    config.set('theme', 'dark', 'global');

    expect(config.get('theme')).toBe('dark');
    expect(config.get('theme', 'default')).toBe('light');
    expect(config.get('theme', 'project')).toBeUndefined();
  });

  it('writes and deletes the highest priority type by default', () => {
    const config = new ConfigModule();
    config.registerTypes([...TYPES]);

    config.set('theme', 'dark');
    expect(config.get('theme', 'project')).toBe('dark');

    config.delete('theme');
    expect(config.get('theme', 'project')).toBeUndefined();
  });

  it('treats null as a value and delete as fallback', () => {
    const config = new ConfigModule();
    config.registerTypes([...TYPES]);

    config.set('flag', true, 'default');
    config.set('flag', null, 'project');
    expect(config.get('flag')).toBeNull();

    config.delete('flag', 'project');
    expect(config.get('flag')).toBe(true);
  });

  it('shares shared scope and isolates editor scope', () => {
    const sharedStore = new Map();
    const a = new ConfigModule({ sharedStore });
    const b = new ConfigModule({ sharedStore });

    a.registerTypes([...TYPES]);
    b.registerTypes([...TYPES]);

    a.set('theme', 'dark', 'global');
    a.set('theme', 'light', 'project');

    expect(b.get('theme')).toBe('dark');
    expect(b.get('theme', 'project')).toBeUndefined();
  });

  it('emits lightweight events and unsubscribes cleanly', () => {
    const config = new ConfigModule();
    config.registerTypes([...TYPES]);

    const listener = vi.fn();
    const dispose = config.subscribe(listener);

    config.set('theme', 'dark', 'project');
    config.delete('theme', 'project');

    expect(listener).toHaveBeenNthCalledWith(1, {
      key: 'theme',
      type: 'project',
      scope: 'editor',
      action: 'set',
    });
    expect(listener).toHaveBeenNthCalledWith(2, {
      key: 'theme',
      type: 'project',
      scope: 'editor',
      action: 'delete',
    });

    dispose();
    dispose();
    config.set('theme', 'light', 'project');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid registry and invalid values', () => {
    const config = new ConfigModule();

    expect(() => config.registerTypes([])).toThrow();
    expect(() =>
      config.registerTypes([
        { name: 'global', priority: 1, scope: 'shared' },
        { name: 'global', priority: 2, scope: 'editor' },
      ]),
    ).toThrow();

    config.registerTypes([...TYPES]);

    expect(() => config.registerTypes([...TYPES])).toThrow();
    expect(() => config.set('bad', undefined as never, 'project')).toThrow();
    expect(() => config.get('x', 'missing')).toThrow();
  });
});
