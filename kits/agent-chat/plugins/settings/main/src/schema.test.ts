import assert from 'node:assert/strict';
import test from 'node:test';
import { SettingsSchemaError, sortSettingsPages, validateSettingsContribution } from './schema.ts';

const contribution = (settings: Record<string, unknown> = {}) => ({
  settings: { schemaVersion: 2, panel: 'settings', title: '模型设置', requests: ['getSettings'], ...settings },
});

test('validates and normalizes v2 page contributions', () => {
  const page = validateSettingsContribution('model-service', contribution({ order: 3 }));
  assert.deepEqual(page, { schemaVersion: 2, panel: 'settings', title: '模型设置', order: 3, requests: ['getSettings'] });
  assert.throws(() => validateSettingsContribution('model-service', contribution({ schemaVersion: 1 })), /schemaVersion must be 2/);
  assert.throws(() => validateSettingsContribution('model-service', contribution({ requests: ['getSettings', 'getSettings'] })), /duplicate/);
  assert.throws(() => validateSettingsContribution('model-service', contribution({ requests: [42] })), SettingsSchemaError);
  assert.throws(() => validateSettingsContribution('model-service', contribution({ order: Infinity })), /finite/);
});

test('sorts settings pages by order, title, and owner', () => {
  const pages = sortSettingsPages([
    { owner: 'z', panel: 'z.settings', title: '相同', order: 1, requests: [], entry: '/z' },
    { owner: 'a', panel: 'a.settings', title: '相同', order: 1, requests: [], entry: '/a' },
    { owner: 'b', panel: 'b.settings', title: '优先', order: 0, requests: [], entry: '/b' },
  ]);
  assert.deepEqual(pages.map((page) => page.owner), ['b', 'a', 'z']);
});
