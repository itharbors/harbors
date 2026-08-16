import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptConversationUiState, createConversationUiStateGate } from './ui-state-gate.ts';

const state = (sequence: number, generation: string, revision: number) => ({ sequence, generation, revision });

test('accepts a new generation but rejects a late broadcast from a seen generation', () => {
  const gate = createConversationUiStateGate();

  assert.equal(acceptConversationUiState(gate, state(1, 'A', 8)), true);
  assert.equal(acceptConversationUiState(gate, state(2, 'B', 1)), true);
  assert.equal(acceptConversationUiState(gate, state(3, 'A', 99)), false);
  assert.equal(gate.latestGeneration, 'B');
  assert.equal(gate.latestRevision, 1);
});

test('rejects an initialization response that started before a newer generation event', () => {
  const gate = createConversationUiStateGate();

  assert.equal(acceptConversationUiState(gate, state(0, 'A', 4)), true);
  assert.equal(acceptConversationUiState(gate, state(2, 'B', 0)), true);
  assert.equal(acceptConversationUiState(gate, state(0, 'A', 5)), false);
  assert.equal(gate.latestGeneration, 'B');
});

test('keeps revision monotonic within one generation', () => {
  const gate = createConversationUiStateGate();

  assert.equal(acceptConversationUiState(gate, state(1, 'A', 2)), true);
  assert.equal(acceptConversationUiState(gate, state(2, 'A', 1)), false);
  assert.equal(acceptConversationUiState(gate, state(3, 'A', 3)), true);
});
