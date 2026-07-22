import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NotificationError,
  createNotificationHost,
  createNotificationStore,
  parseNotificationPort,
} from './notification-host.mjs';

test('parses the configured notification port', () => {
  assert.equal(parseNotificationPort(undefined), 48383);
  assert.equal(parseNotificationPort('18000'), 18000);
  assert.throws(() => parseNotificationPort('0'), /between 1 and 65535/);
  assert.throws(() => parseNotificationPort('65536'), /between 1 and 65535/);
  assert.throws(() => parseNotificationPort('12.5'), /between 1 and 65535/);
});

test('creates a normalized notification and keeps returned snapshots isolated', () => {
  const store = createNotificationStore({
    randomUUID: () => 'notification-1',
    now: () => new Date('2026-07-21T10:00:00.000Z'),
  });

  const created = store.create({
    title: ' Done ',
    body: ' Built ',
    level: 'success',
  });

  assert.deepEqual(created, {
    id: 'notification-1',
    title: 'Done',
    body: ' Built ',
    level: 'success',
    source: null,
    durationMs: 8000,
    persistent: false,
    createdAt: '2026-07-21T10:00:00.000Z',
    read: false,
  });
  created.title = 'mutated';
  const snapshot = store.snapshot();
  assert.equal(snapshot.unreadCount, 1);
  assert.equal(snapshot.notifications[0].title, 'Done');
});

test('normalizes persistent notifications without a duration', () => {
  const store = createNotificationStore({ randomUUID: () => 'persistent-1' });
  const created = store.create({
    title: 'Needs attention',
    persistent: true,
    durationMs: 1200,
    source: 'Codex',
  });

  assert.equal(created.persistent, true);
  assert.equal(created.durationMs, null);
  assert.equal(created.source, 'Codex');
  assert.equal(created.body, '');
  assert.equal(created.level, 'info');
});

test('rejects invalid and undeclared notification fields', () => {
  const invalidInputs = [
    [{}, /title is required/],
    [{ title: ' '.repeat(2) }, /title is required/],
    [{ title: 'x'.repeat(121) }, /title must be at most 120/],
    [{ title: 'x', body: null }, /body must be a string/],
    [{ title: 'x', body: 'x'.repeat(2001) }, /body must be at most 2000/],
    [{ title: 'x', level: 'debug' }, /level must be one of/],
    [{ title: 'x', source: 'x'.repeat(81) }, /source must be at most 80/],
    [{ title: 'x', source: null }, /source must be a string/],
    [{ title: 'x', persistent: 'yes' }, /persistent must be a boolean/],
    [{ title: 'x', durationMs: null }, /durationMs must be between 1000 and 60000/],
    [{ title: 'x', durationMs: 999 }, /durationMs must be between 1000 and 60000/],
    [{ title: 'x', durationMs: 60001 }, /durationMs must be between 1000 and 60000/],
    [{ title: 'x', extra: true }, /Unknown notification field: extra/],
  ];
  const store = createNotificationStore();

  for (const [input, message] of invalidInputs) {
    assert.throws(
      () => store.create(input),
      (error) => error instanceof NotificationError && error.status === 400 && message.test(error.message),
    );
  }
});

test('emits snapshots after create, read, read-all and removal mutations', () => {
  let nextId = 0;
  const store = createNotificationStore({ randomUUID: () => `id-${++nextId}` });
  const events = [];
  const unsubscribe = store.subscribe((event) => events.push(event));

  store.create({ title: 'First' });
  store.create({ title: 'Second' });
  assert.equal(store.markRead('id-1').read, true);
  assert.deepEqual(store.markAllRead(), { unreadCount: 0 });
  assert.equal(store.remove('id-2'), true);
  assert.deepEqual(events.map((event) => event.type), [
    'created',
    'created',
    'changed',
    'changed',
    'removed',
  ]);
  assert.deepEqual(events.map((event) => event.snapshot.unreadCount), [1, 2, 1, 0, 0]);

  unsubscribe();
  store.create({ title: 'Third' });
  assert.equal(events.length, 5);
  assert.throws(() => store.markRead('missing'), /Notification not found/);
  assert.throws(() => store.remove('missing'), /Notification not found/);
});

test('evicts the oldest read notification before an older unread notification', () => {
  let nextId = 0;
  const store = createNotificationStore({
    maxEntries: 3,
    randomUUID: () => `id-${++nextId}`,
    now: () => new Date(`2026-07-21T10:00:0${nextId}.000Z`),
  });

  store.create({ title: 'Unread oldest' });
  store.create({ title: 'Read middle' });
  store.markRead('id-2');
  store.create({ title: 'Unread newest' });
  const overflowEvents = [];
  store.subscribe((event) => overflowEvents.push(event));
  store.create({ title: 'Overflow' });

  assert.deepEqual(
    store.snapshot().notifications.map((notification) => notification.id),
    ['id-4', 'id-3', 'id-1'],
  );
  assert.equal(store.snapshot().unreadCount, 3);
  assert.deepEqual(
    overflowEvents.map((event) => [event.type, event.id ?? event.notification?.id]),
    [['removed', 'id-2'], ['created', 'id-4']],
  );
});

test('dispose is idempotent and clears state and listeners', () => {
  const store = createNotificationStore({ randomUUID: () => 'id-1' });
  let calls = 0;
  store.subscribe(() => { calls += 1; });
  store.create({ title: 'Before dispose' });
  store.dispose();
  store.dispose();

  assert.deepEqual(store.snapshot(), { notifications: [], unreadCount: 0 });
  store.create({ title: 'After dispose' });
  assert.equal(calls, 1);
});

test('serves the complete notification API on a loopback port', async (t) => {
  let nextId = 0;
  const store = createNotificationStore({ randomUUID: () => `http-${++nextId}` });
  const host = createNotificationHost({ store, port: 0 });
  const port = await host.start();
  t.after(() => host.stop());
  const url = (pathname) => `http://127.0.0.1:${port}${pathname}`;

  const health = await fetch(url('/health'));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  assert.equal(health.headers.get('access-control-allow-origin'), null);

  const createdResponse = await fetch(url('/v1/notifications'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Agent finished', level: 'success' }),
  });
  assert.equal(createdResponse.status, 201);
  assert.match(createdResponse.headers.get('content-type'), /^application\/json/);
  assert.equal((await createdResponse.json()).id, 'http-1');

  const listResponse = await fetch(url('/v1/notifications'));
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  assert.equal(list.unreadCount, 1);
  assert.equal(list.notifications.length, 1);
  assert.equal(list.notifications[0].title, 'Agent finished');

  const read = await fetch(url('/v1/notifications/http-1/read'), { method: 'POST' });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).read, true);

  const readAll = await fetch(url('/v1/notifications/read-all'), { method: 'POST' });
  assert.deepEqual(await readAll.json(), { unreadCount: 0 });

  const removed = await fetch(url('/v1/notifications/http-1'), { method: 'DELETE' });
  assert.equal(removed.status, 204);
  assert.equal(await removed.text(), '');
});

test('returns structured HTTP errors for invalid requests', async (t) => {
  const host = createNotificationHost({ store: createNotificationStore(), port: 0 });
  const port = await host.start();
  t.after(() => host.stop());
  const url = (pathname) => `http://127.0.0.1:${port}${pathname}`;

  const cases = [
    [await fetch(url('/v1/notifications'), { method: 'PUT' }), 405, 'METHOD_NOT_ALLOWED'],
    [await fetch(url('/unknown')), 404, 'NOT_FOUND'],
    [await fetch(url('/v1/notifications'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    }), 400, 'INVALID_JSON'],
    [await fetch(url('/v1/notifications'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x'.repeat(20_000) }),
    }), 413, 'PAYLOAD_TOO_LARGE'],
    [await fetch(url('/v1/notifications/missing/read'), { method: 'POST' }), 404, 'NOTIFICATION_NOT_FOUND'],
  ];

  for (const [response, status, code] of cases) {
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(body.error.code, code);
    assert.equal(typeof body.error.message, 'string');
  }
});

test('rejects browser-origin mutations and non-JSON notification creation', async (t) => {
  const store = createNotificationStore();
  const host = createNotificationHost({ store, port: 0 });
  const port = await host.start();
  t.after(() => host.stop());
  const url = (pathname) => `http://127.0.0.1:${port}${pathname}`;

  const crossOriginCreate = await fetch(url('/v1/notifications'), {
    method: 'POST',
    headers: {
      origin: 'https://malicious.example',
      'content-type': 'text/plain',
    },
    body: JSON.stringify({ title: 'Browser injected' }),
  });
  assert.equal(crossOriginCreate.status, 403);
  assert.equal((await crossOriginCreate.json()).error.code, 'BROWSER_REQUEST_REJECTED');

  const wrongContentType = await fetch(url('/v1/notifications'), {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ title: 'Plain text JSON' }),
  });
  assert.equal(wrongContentType.status, 415);
  assert.equal((await wrongContentType.json()).error.code, 'UNSUPPORTED_MEDIA_TYPE');

  const crossOriginReadAll = await fetch(url('/v1/notifications/read-all'), {
    method: 'POST',
    headers: { origin: 'https://malicious.example' },
  });
  assert.equal(crossOriginReadAll.status, 403);
  assert.deepEqual(store.snapshot(), { notifications: [], unreadCount: 0 });
});

test('rejects non-loopback binding and starts and stops idempotently', async () => {
  assert.throws(
    () => createNotificationHost({ store: createNotificationStore(), host: '0.0.0.0' }),
    /must bind to 127\.0\.0\.1/,
  );

  const host = createNotificationHost({ store: createNotificationStore(), port: 0 });
  const firstPort = await host.start();
  assert.equal(await host.start(), firstPort);
  await host.stop();
  await host.stop();
});
