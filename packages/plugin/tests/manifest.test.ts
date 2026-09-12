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
      requires: { plugins: [] },
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.contribute.panel)).toBe(true);
  });

  it('strictly parses Plugin hard dependencies', () => {
    const input = structuredClone(manifest);
    (input['ce-editor'] as Record<string, unknown>).requires = {
      plugins: ['model-service', '@example/context-store'],
    };
    const parsed = parsePluginPackageManifest(input);
    expect(parsed.requires.plugins).toEqual(['model-service', '@example/context-store']);
    expect(Object.isFrozen(parsed.requires)).toBe(true);
    expect(Object.isFrozen(parsed.requires.plugins)).toBe(true);
  });

  it.each([
    { plugins: ['model-service', 'model-service'] },
    { plugins: [] as string[], extra: true },
    { plugins: ['Bad Name'] },
    { plugins: 'model-service' },
    {},
  ])('rejects invalid Plugin hard dependencies %#', (requires) => {
    const input = structuredClone(manifest);
    (input['ce-editor'] as Record<string, unknown>).requires = requires;
    try {
      parsePluginPackageManifest(input);
      throw new Error('Expected invalid requires to be rejected');
    } catch (error) {
      expect(error).toMatchObject({ code: 'PLUGIN_DEPENDENCY_INVALID', plugin: '@example/demo' });
    }
  });

  it('requires an explicit schemaVersion', () => {
    const input = structuredClone(manifest);
    delete (input['ce-editor'] as { schemaVersion?: number }).schemaVersion;
    expect(() => parsePluginPackageManifest(input)).toThrow(/schemaVersion/i);
  });

  it('accepts object message routes with a unique non-empty caller allowlist', () => {
    const input = structuredClone(manifest);
    input['ce-editor'].contribute.message!.request = {
      complete: { methods: ['complete'], callers: ['settings', 'model-service'] },
    };
    const parsed = parsePluginPackageManifest(input);
    expect(parsed.contribute.message?.request?.complete).toEqual({
      methods: ['complete'],
      callers: ['settings', 'model-service'],
    });
  });

  it.each([
    { methods: ['complete'], callers: [] },
    { methods: ['complete'], callers: ['settings', 'settings'] },
    { methods: ['complete'], callers: [''] },
  ])('rejects invalid message caller allowlists %#', (route) => {
    const input = structuredClone(manifest);
    input['ce-editor'].contribute.message!.request = { complete: route };
    expect(() => parsePluginPackageManifest(input)).toThrow(/callers|duplicate|non-empty/i);
  });

  it('preserves and deeply freezes unknown contributions', () => {
    const input = structuredClone(manifest);
    const settings = {
      appearance: { theme: 'dark', density: 0.9 },
      flags: [true, null, { enabled: false }],
    };
    (input['ce-editor'].contribute as Record<string, unknown>).settings = settings;

    const parsed = parsePluginPackageManifest(input);
    expect(parsed.contribute.settings).toEqual(settings);
    expect(Object.isFrozen(parsed.contribute.settings)).toBe(true);
    expect(Object.isFrozen((parsed.contribute.settings as { appearance: object }).appearance)).toBe(true);
    expect(Object.isFrozen((parsed.contribute.settings as { flags: readonly unknown[] }).flags)).toBe(true);
    expect(Object.isFrozen(
      (parsed.contribute.settings as { flags: readonly [{ enabled: object }] }).flags[2],
    )).toBe(true);

    settings.appearance.theme = 'light';
    expect((parsed.contribute.settings as { appearance: { theme: string } }).appearance.theme).toBe('dark');
  });

  function withUnknownContribution(value: unknown) {
    const input = structuredClone(manifest);
    (input['ce-editor'].contribute as Record<string, unknown>).settings = value;
    return input;
  }

  it.each([
    [undefined, /JSON-safe/],
    [() => 'not data', /JSON-safe/],
    [Symbol('not data'), /JSON-safe/],
    [1n, /JSON-safe/],
    [Number.NaN, /JSON-safe/],
    [Number.POSITIVE_INFINITY, /JSON-safe/],
    [(() => { const value: Record<string, unknown> = {}; value.self = value; return value; })(), /circular/],
    [(() => { const value: unknown[] = []; value.length = 1; return value; })(), /sparse/],
    [Object.create({ inherited: true }), /ordinary objects/],
  ])('rejects unsafe unknown contributions %#', (value, pattern) => {
    expect(() => parsePluginPackageManifest(withUnknownContribution(value))).toThrow(pattern);
  });

  it('keeps the known contribution validators strict', () => {
    const invalidPanel = structuredClone(manifest);
    invalidPanel['ce-editor'].contribute.panel.demo.entry = '../outside.html';
    expect(() => parsePluginPackageManifest(invalidPanel)).toThrow(/portable relative/i);

    const invalidMessage = structuredClone(manifest);
    (invalidMessage['ce-editor'].contribute.message as Record<string, unknown>).extra = {};
    expect(() => parsePluginPackageManifest(invalidMessage)).toThrow(/unexpected field/i);
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
