import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculateToastPositions,
  createBadgeOverlayDataUrl,
  createNotificationHtml,
  createToastQueue,
  formatNotificationCount,
  formatNotificationKitLabel,
  formatNotificationTooltip,
} from './notification-desktop.mjs';

test('shows three toasts and promotes FIFO overflow after a close', () => {
  const shown = [];
  const hidden = [];
  const queue = createToastQueue({
    limit: 3,
    onShow: (notification) => shown.push(notification.id),
    onHide: (notification, reason) => hidden.push([notification.id, reason]),
  });

  for (let index = 1; index <= 5; index += 1) {
    queue.enqueue(notification(`n-${index}`, { persistent: true }));
  }
  assert.deepEqual(queue.snapshot(), {
    visible: ['n-1', 'n-2', 'n-3'],
    pending: ['n-4', 'n-5'],
  });
  assert.deepEqual(shown, ['n-1', 'n-2', 'n-3']);

  assert.equal(queue.close('n-2'), true);
  assert.deepEqual(queue.snapshot(), {
    visible: ['n-1', 'n-3', 'n-4'],
    pending: ['n-5'],
  });
  assert.deepEqual(hidden, [['n-2', 'closed']]);
  assert.deepEqual(shown, ['n-1', 'n-2', 'n-3', 'n-4']);
});

test('expires transient toasts but never schedules persistent toasts', () => {
  const timers = new Map();
  const markShown = new Map();
  let nextTimer = 0;
  const hidden = [];
  const queue = createToastQueue({
    schedule: (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    cancelSchedule: (id) => timers.delete(id),
    onShow: (item, ready) => markShown.set(item.id, ready),
    onHide: (item, reason) => hidden.push([item.id, reason]),
  });

  queue.enqueue(notification('transient', { durationMs: 1500 }));
  queue.enqueue(notification('persistent', { persistent: true }));
  assert.equal(timers.size, 0);
  markShown.get('transient')();
  markShown.get('persistent')();
  assert.deepEqual(Array.from(timers.values()).map((timer) => timer.delay), [1500]);
  Array.from(timers.values())[0].callback();

  assert.deepEqual(queue.snapshot().visible, ['persistent']);
  assert.deepEqual(hidden, [['transient', 'expired']]);
});

test('removes pending and visible toasts and disposes idempotently', () => {
  const hidden = [];
  const queue = createToastQueue({
    limit: 1,
    onHide: (item, reason) => hidden.push([item.id, reason]),
  });
  queue.enqueue(notification('visible', { persistent: true }));
  queue.enqueue(notification('pending', { persistent: true }));

  assert.equal(queue.remove('pending'), true);
  assert.equal(queue.remove('missing'), false);
  assert.equal(queue.remove('visible'), true);
  assert.deepEqual(hidden, [['visible', 'removed']]);
  assert.deepEqual(queue.snapshot(), { visible: [], pending: [] });

  queue.enqueue(notification('dispose', { persistent: true }));
  queue.dispose();
  queue.dispose();
  assert.deepEqual(hidden.at(-1), ['dispose', 'disposed']);
  assert.equal(queue.enqueue(notification('late')), false);
});

test('ignores duplicate notification ids', () => {
  const queue = createToastQueue();
  assert.equal(queue.enqueue(notification('same', { persistent: true })), true);
  assert.equal(queue.enqueue(notification('same', { persistent: true })), false);
  assert.deepEqual(queue.snapshot().visible, ['same']);
  queue.dispose();
});

test('escapes notification data in self-contained toast HTML', () => {
  const html = createNotificationHtml(notification('safe', {
    title: '<script>alert("title")</script>',
    body: 'Use <b>literal</b> & stay safe',
    source: 'A "quoted" agent',
    level: 'warning',
    persistent: true,
  }));

  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<b>literal<\/b>/);
  assert.match(html, /&lt;script&gt;alert\(&quot;title&quot;\)&lt;\/script&gt;/);
  assert.match(html, /Use &lt;b&gt;literal&lt;\/b&gt; &amp; stay safe/);
  assert.match(html, /A &quot;quoted&quot; agent/);
  assert.match(html, /data-action="open"/);
  assert.match(html, /data-action="close"/);
  assert.match(html, /notificationToast\.openCenter/);
  assert.match(html, /notificationToast\.closeToast/);
  assert.match(html, /Persistent/);
});

test('formats badge, Kit label and tooltip counts', () => {
  assert.equal(formatNotificationCount(0), '0');
  assert.equal(formatNotificationCount(7), '7');
  assert.equal(formatNotificationCount(100), '99+');
  assert.equal(createBadgeOverlayDataUrl(0), null);
  const badge = createBadgeOverlayDataUrl(100);
  assert.match(badge, /^data:image\/svg\+xml/);
  assert.match(decodeURIComponent(badge), />99\+</);
  assert.equal(formatNotificationKitLabel('Notifications', 0), 'Notifications');
  assert.equal(formatNotificationKitLabel('Notifications', 4), 'Notifications (4)');
  assert.equal(formatNotificationTooltip(0), 'ITHARBORS — No unread notifications');
  assert.equal(formatNotificationTooltip(1), 'ITHARBORS — 1 unread notification');
  assert.equal(formatNotificationTooltip(3), 'ITHARBORS — 3 unread notifications');
});

test('positions toast windows from the bottom-right of a display work area', () => {
  assert.deepEqual(calculateToastPositions(
    { x: 100, y: 50, width: 1200, height: 800 },
    [176, 200, 160],
  ), [
    { x: 924, y: 658 },
    { x: 924, y: 446 },
    { x: 924, y: 274 },
  ]);
});

function notification(id, overrides = {}) {
  return {
    id,
    title: 'Task completed',
    body: 'The background operation finished.',
    level: 'success',
    source: 'Codex',
    durationMs: 8000,
    persistent: false,
    createdAt: '2026-07-21T10:00:00.000Z',
    read: false,
    ...overrides,
  };
}
