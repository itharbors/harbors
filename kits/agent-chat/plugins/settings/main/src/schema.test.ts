import assert from 'node:assert/strict';
import test from 'node:test';
import { SettingsSchemaError, sortSettingsPages, validateSettingsContribution } from './schema.ts';

const contribution = (settings: Record<string, unknown> = {}) => ({
  settings: { schemaVersion: 3, panel: 'settings', ...settings },
});

test('validates and normalizes v3 page contributions', () => {
  const page = validateSettingsContribution('model-service', contribution({ order: 3 }));
  assert.deepEqual(page, { schemaVersion: 3, panel: 'settings', order: 3 });
  assert.throws(() => validateSettingsContribution('model-service', contribution({ schemaVersion: 2 })), /schemaVersion must be 3/);
  assert.throws(() => validateSettingsContribution('model-service', contribution({ title: '旧标题' })), /settings.title is not allowed/);
  assert.throws(() => validateSettingsContribution('model-service', contribution({ requests: ['getSettings'] })), /settings.requests is not allowed/);
  assert.throws(() => validateSettingsContribution('model-service', contribution({ order: Infinity })), /finite/);
  assert.throws(() => validateSettingsContribution('model-service', contribution({ extra: true })), /not allowed/);
});

test('sorts settings pages by order, title, and owner', () => {
  const pages = sortSettingsPages([
    { owner: 'z', panel: 'z.settings', title: '相同', order: 1, entry: '/z' },
    { owner: 'a', panel: 'a.settings', title: '相同', order: 1, entry: '/a' },
    { owner: 'b', panel: 'b.settings', title: '优先', order: 0, entry: '/b' },
  ]);
  assert.deepEqual(pages.map((page) => page.owner), ['b', 'a', 'z']);
});

test('throws the dedicated schema error for malformed contributions', () => {
  assert.throws(() => validateSettingsContribution('model-service', contribution({ panel: '' })), SettingsSchemaError);
  assert.throws(() => validateSettingsContribution('model-service', contribution({ order: 'high' })), SettingsSchemaError);
});
