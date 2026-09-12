import { describe, expect, it } from 'vitest';

import { resolvePluginLoadOrder } from '../src/index.js';

describe('resolvePluginLoadOrder', () => {
  it('uses a stable topological order for multi-level and diamond dependencies', () => {
    const plugins = [
      { name: 'consumer', requires: { plugins: ['left', 'right'] } },
      { name: 'unrelated' },
      { name: 'right', requires: { plugins: ['base'] } },
      { name: 'left', requires: { plugins: ['base'] } },
      { name: 'base' },
    ];
    expect(resolvePluginLoadOrder(plugins).map((plugin) => plugin.name))
      .toEqual(['unrelated', 'base', 'right', 'left', 'consumer']);
  });

  it('accepts dependencies already supplied by the host', () => {
    const plugins = [{ name: 'consumer', requires: { plugins: ['framework-plugin'] } }];
    expect(resolvePluginLoadOrder(plugins, ['framework-plugin'])).toEqual(plugins);
  });

  it.each([
    {
      plugins: [{ name: 'consumer', requires: { plugins: ['missing'] } }],
      code: 'PLUGIN_DEPENDENCY_MISSING',
    },
    {
      plugins: [{ name: 'self', requires: { plugins: ['self'] } }],
      code: 'PLUGIN_DEPENDENCY_INVALID',
    },
    {
      plugins: [
        { name: 'left', requires: { plugins: ['right'] } },
        { name: 'right', requires: { plugins: ['left'] } },
      ],
      code: 'PLUGIN_DEPENDENCY_CYCLE',
    },
  ])('reports stable dependency errors %#', ({ plugins, code }) => {
    try {
      resolvePluginLoadOrder(plugins);
      throw new Error('Expected dependency resolution to fail');
    } catch (error) {
      expect(error).toMatchObject({ code });
    }
  });
});
