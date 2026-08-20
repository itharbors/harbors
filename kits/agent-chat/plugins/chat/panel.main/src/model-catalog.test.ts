import assert from 'node:assert/strict';
import test from 'node:test';
import { applyModelCatalog, selectModelForCatalog } from './model-catalog.ts';

const payload = (catalog: Record<string, unknown>, revision = 1) => ({ revision, reason: 'provider-saved', catalog });

test('clears the configuration error as soon as a healthy catalog arrives', () => {
  assert.deepEqual(applyModelCatalog('', payload({ models: [{ id: 'model-a', name: 'A' }], defaultModel: 'model-a' })), {
    models: [{ id: 'model-a', name: 'A' }], model: 'model-a', configurationError: null, revision: 1,
  });
});

test('falls back to the catalog default or first model when the current model was deleted', () => {
  assert.equal(applyModelCatalog('deleted', payload({ models: [{ id: 'model-b', name: 'B' }], defaultModel: 'model-b' }))?.model, 'model-b');
  assert.equal(applyModelCatalog('deleted', payload({ models: [{ id: 'model-c', name: 'C' }], defaultModel: '' }))?.model, 'model-c');
});

test('keeps the current model while it remains in the catalog', () => {
  assert.equal(applyModelCatalog('model-a', payload({ models: [{ id: 'model-a', name: 'A' }, { id: 'model-b', name: 'B' }], defaultModel: 'model-b' }))?.model, 'model-a');
});

test('selects the broadcast default using the latest current model, not an initial render value', () => {
  const catalog = applyModelCatalog('B', payload({ models: [{ id: 'A', name: 'A' }, { id: 'C', name: 'C' }], defaultModel: 'C' }))!.models;
  assert.equal(selectModelForCatalog('B', { models: catalog, defaultModel: 'C' }), 'C');
});

test('does not treat revision as a cross-restart ordering gate', () => {
  assert.equal(applyModelCatalog('model-a', payload({ models: [{ id: 'model-b', name: 'B' }], defaultModel: 'model-b' }, 1))?.model, 'model-b');
  assert.equal(applyModelCatalog('model-b', payload({ models: [{ id: 'model-a', name: 'A' }], defaultModel: 'model-a' }, 1))?.model, 'model-a');
});

test('updates configurationError and normalizes model option fields', () => {
  const result = applyModelCatalog('missing', payload({
    models: [{ id: 'model-a', name: 'A', reasoningEfforts: ['low'], serviceTiers: [{ id: 'fast', name: 'Fast' }] }],
    defaultModel: '', configurationError: { message: '模型服务未配置凭据' },
  }));
  assert.equal(result?.configurationError, '模型服务未配置凭据');
  assert.deepEqual(result?.models[0]?.reasoningEfforts, [{ id: 'low', name: 'low' }]);
  assert.deepEqual(result?.models[0]?.serviceTiers, [{ id: 'fast', name: 'Fast' }]);
});
