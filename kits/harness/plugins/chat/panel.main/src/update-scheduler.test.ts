import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMessageDeltaUpdates, createMessageDeltaScheduler, shouldIgnorePendingBottomScroll, type MessageDeltaUpdate } from './update-scheduler.js';

function createFakeFrames() {
  const callbacks: Array<() => void> = [];
  return {
    callbacks,
    schedule(callback: () => void): number {
      callbacks.push(callback);
      return callbacks.length;
    },
    cancel(_handle: number): void {},
    run(): void {
      const next = callbacks.splice(0);
      next.forEach((callback) => callback());
    },
  };
}

test('coalesces updates for the same message within one frame', () => {
  const frames = createFakeFrames();
  const flushed: MessageDeltaUpdate[][] = [];
  const scheduler = createMessageDeltaScheduler((updates) => flushed.push(updates), frames.schedule, frames.cancel);

  scheduler.enqueue({ messageId: 'msg-1', content: 'a' });
  scheduler.enqueue({ messageId: 'msg-2', content: 'b' });
  scheduler.enqueue({ messageId: 'msg-1', content: 'abc' });
  assert.deepEqual(flushed, []);

  frames.run();
  assert.deepEqual(flushed, [[{ messageId: 'msg-1', content: 'abc' }, { messageId: 'msg-2', content: 'b' }]]);
});

test('flushes immediately and cancels pending updates', () => {
  const frames = createFakeFrames();
  const flushed: MessageDeltaUpdate[][] = [];
  const scheduler = createMessageDeltaScheduler((updates) => flushed.push(updates), frames.schedule, frames.cancel);

  scheduler.enqueue({ messageId: 'msg-1', content: 'final' });
  scheduler.flush();
  frames.run();
  assert.deepEqual(flushed, [[{ messageId: 'msg-1', content: 'final' }]]);

  scheduler.enqueue({ messageId: 'msg-1', content: 'discarded' });
  scheduler.cancel();
  frames.run();
  assert.equal(flushed.length, 1);
});

test('keeps a queued bottom follow alive through passive scroll but not explicit user scroll', () => {
  assert.equal(shouldIgnorePendingBottomScroll(true, 'passive'), true);
  assert.equal(shouldIgnorePendingBottomScroll(true, 'explicit-user'), false);
  assert.equal(shouldIgnorePendingBottomScroll(false, 'passive'), false);
});

test('applies existing messages in one pass and appends new assistant messages', () => {
  assert.deepEqual(applyMessageDeltaUpdates([
    { id: 'msg-1', role: 'assistant', content: 'old' },
    { id: 'opt-1', role: 'user', content: 'question' },
  ], [
    { messageId: 'msg-1', content: 'new' },
    { messageId: 'msg-2', content: 'answer' },
  ]), [
    { id: 'msg-1', role: 'assistant', content: 'new' },
    { id: 'opt-1', role: 'user', content: 'question' },
    { id: 'msg-2', role: 'assistant', content: 'answer' },
  ]);
});

test('流式 delta 只接受当前 generation 的严格 sequence，拒绝重复乱序和晚到事件', () => {
  const flushed: MessageDeltaUpdate[][] = [];
  const scheduler = createMessageDeltaScheduler((updates) => flushed.push(updates), (callback) => { callback(); return 1; }, () => undefined);
  scheduler.enqueue({ messageId: 'm', content: 'a', requestId: 'r', generation: 'g1', sequence: 0 });
  scheduler.enqueue({ messageId: 'm', content: 'late', requestId: 'r', generation: 'g1', sequence: 0 });
  scheduler.enqueue({ messageId: 'm', content: 'gap', requestId: 'r', generation: 'g1', sequence: 2 });
  scheduler.enqueue({ messageId: 'm', content: 'b', requestId: 'r', generation: 'g1', sequence: 1 });
  scheduler.enqueue({ messageId: 'm', content: 'old', requestId: 'r', generation: 'g1', sequence: 2 });
  scheduler.enqueue({ messageId: 'm', content: 'new', requestId: 'r2', generation: 'g2', sequence: 0 });
  scheduler.enqueue({ messageId: 'm', content: 'old-again', requestId: 'r', generation: 'g1', sequence: 3 });
  assert.deepEqual(flushed.map((batch) => batch.at(-1)?.content), ['a', 'b', 'old', 'new']);
});
