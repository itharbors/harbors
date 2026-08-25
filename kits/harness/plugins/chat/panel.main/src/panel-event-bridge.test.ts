import assert from 'node:assert/strict';
import test from 'node:test';
import { createPanelEventBridge } from './panel-event-bridge.ts';

test('reset clears setters and every replay cache before the next mount', () => {
  const bridge = createPanelEventBridge();
  const selected = { selectedConversationId: 'old-conversation' };
  const trace = { conversationId: 'old-conversation', event: { type: 'item/started' } };
  const catalog = { revision: 1, catalog: { models: [{ id: 'old-model' }] } };

  bridge.onConversationSelected(selected);
  bridge.onConversationTraceAppend(trace);
  bridge.onModelCatalogChanged(catalog);

  const firstSelected: unknown[] = [];
  const firstTrace: unknown[] = [];
  const firstCatalog: unknown[] = [];
  bridge.registerSetter('conversation.selected', (value) => firstSelected.push(value));
  bridge.registerSetter('agent.conversation.trace.append', (value) => firstTrace.push(value));
  bridge.registerSetter('model-service.catalog.changed', (value) => firstCatalog.push(value));
  assert.deepEqual(firstSelected, [selected]);
  assert.deepEqual(firstTrace, [trace]);
  assert.deepEqual(firstCatalog, [catalog]);

  bridge.reset();
  bridge.onConversationChanged({ id: 'late' });
  const nextSelected: unknown[] = [];
  const nextTrace: unknown[] = [];
  const nextCatalog: unknown[] = [];
  bridge.registerSetter('conversation.selected', (value) => nextSelected.push(value));
  bridge.registerSetter('agent.conversation.trace.append', (value) => nextTrace.push(value));
  bridge.registerSetter('model-service.catalog.changed', (value) => nextCatalog.push(value));
  assert.deepEqual(nextSelected, []);
  assert.deepEqual(nextTrace, []);
  assert.deepEqual(nextCatalog, []);
});
