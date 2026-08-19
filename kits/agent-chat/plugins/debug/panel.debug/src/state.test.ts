import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_MESSAGES,
  MAX_PAYLOAD_CHARS,
  appendMessage,
  createRequestMessage,
  stringifyPayload,
} from './state.ts';

function message(index: number) {
  return { id: `message-${index}`, type: `Request demo.${index}`, payload: index, timestamp: index };
}

test('keeps only the latest 2000 messages', () => {
  let messages = [] as ReturnType<typeof message>[];
  for (let index = 0; index < MAX_MESSAGES + 3; index += 1) {
    messages = appendMessage(messages, message(index));
  }

  assert.equal(messages.length, MAX_MESSAGES);
  assert.equal(messages[0].payload, 3);
  assert.equal(messages.at(-1)?.payload, MAX_MESSAGES + 2);
});

test('keeps stable unique ids when old messages are evicted', () => {
  let messages = Array.from({ length: MAX_MESSAGES }, (_, index) => message(index));
  const survivingIds = messages.slice(1).map((entry) => entry.id);

  messages = appendMessage(messages, message(MAX_MESSAGES));

  assert.deepEqual(messages.slice(0, -1).map((entry) => entry.id), survivingIds);
  assert.equal(new Set(messages.map((entry) => entry.id)).size, MAX_MESSAGES);
});

test('trims payload before it enters the frontend queue', () => {
  const payload = { text: 'x'.repeat(20000), nested: { value: 'y'.repeat(20000) } };
  const captured = createRequestMessage({ plugin: 'demo', name: 'run' }, [payload], 1);
  const serialized = stringifyPayload(captured.payload, true);

  assert.notEqual(captured.payload, payload);
  assert.ok(serialized.length <= MAX_PAYLOAD_CHARS);
  assert.ok(String(captured.payload).length <= MAX_PAYLOAD_CHARS);
  assert.ok(captured.id.length > 0);
});
