import assert from 'node:assert/strict';
import test from 'node:test';
import { OVERSCAN, getVirtualWindow, shouldFollowLatest } from './virtualization.ts';

test('renders only a viewport window with overscan', () => {
  const messages = Array.from({ length: 2000 }, (_, index) => ({ id: `message-${index}` }));
  const window = getVirtualWindow(messages, 19000, 600, new Map());

  assert.equal(window.start, 492);
  assert.equal(window.end, 524);
  assert.ok(window.end - window.start < 100);
  assert.equal(OVERSCAN, 8);
  assert.ok(window.top > 0);
  assert.ok(window.bottom > 0);
});

test('uses measured variable row heights for offsets and visibility', () => {
  const messages = Array.from({ length: 5 }, (_, index) => ({ id: `message-${index}` }));
  const heights = new Map([['message-0', 100]]);

  const window = getVirtualWindow(messages, 105, 10, heights, 10, 0);

  assert.deepEqual(window, {
    start: 1,
    end: 3,
    top: 100,
    bottom: 20,
  });
});

test('follows the latest message only when already near the bottom', () => {
  assert.equal(shouldFollowLatest(9400, 600, 10000), true);
  assert.equal(shouldFollowLatest(2000, 600, 10000), false);
});
