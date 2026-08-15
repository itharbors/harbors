import { describe, expect, it } from 'vitest';

import { parsePluginPackageManifest } from '../src/index.js';

const manifest = {
  name: '@example/demo',
  version: '1.2.3',
  type: 'module',
  main: './main/dist/index.js',
  'ce-editor': {
    schemaVersion: 1,
    capabilities: ['credentials'],
    assets: { public: ['./resources'] },
    contribute: {
      panel: { demo: { entry: './panel.demo/dist/index.html', minWidth: 320 } },
      message: { request: { snapshot: ['getSnapshot'] } },
      menu: [{ type: 'menu', id: 'demo', message: 'open' }],
    },
  },
};

describe('parsePluginPackageManifest', () => {
  it('normalizes and freezes the complete runtime contract', () => {
    const parsed = parsePluginPackageManifest(manifest);
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      name: '@example/demo',
      version: '1.2.3',
      main: './main/dist/index.js',
      capabilities: ['credentials'],
      assets: { public: ['./resources'] },
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.contribute.panel)).toBe(true);
  });

  it('treats a missing schemaVersion as compatible v1', () => {
    const legacy = structuredClone(manifest);
    delete (legacy['ce-editor'] as { schemaVersion?: number }).schemaVersion;
    expect(parsePluginPackageManifest(legacy).schemaVersion).toBe(1);
  });

  it.each([
    [{ ...manifest, version: 'latest' }, /SemVer/i],
    [{ ...manifest, main: '../index.js' }, /portable relative/i],
    [{ ...manifest, main: './main/src/index.ts' }, /dist JavaScript/i],
    [{ ...manifest, 'ce-editor': { ...manifest['ce-editor'], schemaVersion: 2 } }, /schemaVersion/i],
    [{ ...manifest, 'ce-editor': { ...manifest['ce-editor'], capabilities: ['shell'] } }, /unknown/i],
    [{ ...manifest, 'ce-editor': { ...manifest['ce-editor'], extra: true } }, /unexpected/i],
  ])('rejects an invalid contract', (input, pattern) => {
    expect(() => parsePluginPackageManifest(input)).toThrow(pattern as RegExp);
  });
});
