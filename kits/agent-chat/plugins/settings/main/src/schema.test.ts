import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSettingsViewModel,
  SettingsSchemaError,
  validateSettingValue,
  validateSettingsContribution,
} from './schema.ts';

const contribution = (overrides: Record<string, unknown> = {}) => ({
  settings: {
    schemaVersion: 1,
    sections: [{
      id: 'agent',
      title: 'Agent',
      fields: [{ key: 'agent.model', label: 'Model', control: 'select', options: [{ label: 'Fast', value: 'fast' }], defaultValue: 'fast' }],
    }],
    ...overrides,
  },
});

test('validates owner-prefixed fields and rejects duplicate keys', () => {
  const provider = validateSettingsContribution('agent', contribution());
  assert.equal(provider.sections[0].fields[0].key, 'agent.model');
  assert.throws(() => validateSettingsContribution('agent', contribution({ sections: [{ id: 'other', title: 'Other', fields: [{ key: 'other.model', label: 'Model', control: 'text' }] }] })), SettingsSchemaError);
  assert.throws(() => validateSettingsContribution('agent', contribution(), ['agent.model']), /duplicate setting key/);
});

test('validates select options, number bounds and allowed layers', () => {
  assert.throws(() => validateSettingsContribution('agent', contribution({ sections: [{ id: 'agent', title: 'Agent', fields: [{ key: 'agent.model', label: 'Model', control: 'select', options: [] }] }] })), /requires options/);
  assert.throws(() => validateSettingsContribution('agent', { settings: { schemaVersion: 1, sections: [{ id: 'x', title: 'X', fields: [{ key: 'agent.model', label: 'Model', control: 'select', options: [{ label: 'One', value: 1 }, { label: 'Text one', value: '1' }] }] }] } }), /ambiguous option values/);
  assert.throws(() => validateSettingsContribution('agent', { settings: { schemaVersion: 1, sections: [{ id: 'x', title: 'X', fields: [{ key: 'agent.retries', label: 'Retries', control: 'number', layers: ['global'], defaultLayer: 'project' }] }] } }), /defaultLayer/);
  const provider = validateSettingsContribution('agent', { settings: { schemaVersion: 1, sections: [{ id: 'x', title: 'X', fields: [{ key: 'agent.retries', label: 'Retries', control: 'number', min: 1, max: 5, step: 2, defaultValue: 3 }] }] } });
  const field = provider.sections[0].fields[0];
  validateSettingValue(field, 5);
  assert.throws(() => validateSettingValue(field, 4), /step/);
  assert.throws(() => validateSettingValue(field, 8), /at most/);
});

test('resolves project, global, then default values and reports provenance', () => {
  const provider = validateSettingsContribution('agent', contribution());
  const values = new Map([
    ['default', 'fast'],
    ['global', 'global-model'],
    ['project', 'project-model'],
  ]);
  const model = buildSettingsViewModel([provider], (_key, layer) => values.get(layer));
  const field = model.sections[0].fields[0];
  assert.equal(field.resolvedValue, 'project-model');
  assert.equal(field.resolvedLayer, 'project');
  assert.deepEqual(field.perLayer, { default: 'fast', global: 'global-model', project: 'project-model' });
  values.delete('project');
  assert.equal(buildSettingsViewModel([provider], (_key, layer) => values.get(layer)).sections[0].fields[0].resolvedLayer, 'global');
  values.delete('global');
  assert.equal(buildSettingsViewModel([provider], (_key, layer) => values.get(layer)).sections[0].fields[0].resolvedLayer, 'default');
});
