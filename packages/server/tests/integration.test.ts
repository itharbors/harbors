import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer as createServerWithOptions } from '../src/server';
import { testAssembly, testKitFixture } from './helpers/assembly';
import type { ServerResponse } from 'node:http';
import { Writable } from 'node:stream';
import { createTestPluginPathRoots } from './helpers/plugin-paths';

const createServer = (
  options: Omit<Parameters<typeof createServerWithOptions>[0], 'pluginPathRoots'>,
) => createServerWithOptions({ ...options, pluginPathRoots: createTestPluginPathRoots() });

describe('Server Integration', () => {
  let port: number;
  let stop: () => Promise<void>;
  let baseURL: string;
  let testServer: ReturnType<typeof createServer>;

  beforeAll(async () => {
    testServer = createServer({ assembly: testAssembly });
    stop = testServer.stop;
    port = await testServer.start(0);
    baseURL = `http://localhost:${port}`;
  });

  afterAll(async () => {
    await stop();
  });

  it('GET / returns an empty app host so client bootstrap chooses picker or editor first', async () => {
    const resp = await fetch(`${baseURL}/`);
    const html = await resp.text();

    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('<div id="app"></div>');
    expect(html).not.toContain('<editor-app>');
    expect(html).toContain('<meta name="theme-color" content="#111722">');
    expect(html).toContain('ITHARBORS');
  });

  it('GET /api/session/:id returns session info as JSON', async () => {
    // Create session first
    await fetch(`${baseURL}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'e2e-test', workspacePath: '/tmp/e2e' }),
    });

    const resp = await fetch(`${baseURL}/api/session/e2e-test`);
    const data = await resp.json();

    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('application/json');
    expect(data.sessionId).toBe('e2e-test');
    expect(data.workspacePath).toBe('/tmp/e2e');
  });

  it('GET /api/session/:id returns 404 for unknown session', async () => {
    const resp = await fetch(`${baseURL}/api/session/nonexistent`);
    const data = await resp.json();

    expect(resp.status).toBe(404);
    expect(data).toMatchObject({
      error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' },
    });
  });

  it('POST /api/session auto-generates sessionId', async () => {
    const resp = await fetch(`${baseURL}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspacePath: '/tmp/auto' }),
    });
    const data = await resp.json();

    expect(resp.status).toBe(201);
    expect(data.sessionId).toBeDefined();
    expect(data.sessionId).toHaveLength(36); // UUID
    expect(data.workspacePath).toBe('/tmp/auto');
  });

  it('creates a user, allocates an owned Session, and exposes only public workbench summaries', async () => {
    const userResponse = await fetch(`${baseURL}/api/workbench/user`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: '张三' }),
    });
    expect(userResponse.status).toBe(201);
    const user = await userResponse.json() as { userId: string };
    const sessionResponse = await fetch(`${baseURL}/api/workbench/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: user.userId }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = await sessionResponse.json() as { sessionId: string; ownerUserId: string };
    expect(session.ownerUserId).toBe(user.userId);

    const contextResponse = await fetch(`${baseURL}/api/workbench/context`);
    const context = await contextResponse.json() as Record<string, unknown>;
    expect(contextResponse.status).toBe(200);
    expect(JSON.stringify(context)).not.toContain('workspacePath');
    expect(context).toMatchObject({ actor: 'local-admin' });
    expect((context.sessions as Array<{ sessionId: string }>).some((item) => item.sessionId === session.sessionId)).toBe(true);

    const deleteInUse = await fetch(`${baseURL}/api/workbench/user/${user.userId}`, { method: 'DELETE' });
    expect(deleteInUse.status).toBe(409);
    await expect(deleteInUse.json()).resolves.toMatchObject({ error: { code: 'USER_IN_USE' } });
  });

  it('deletes only users without Sessions or authorized devices', async () => {
    const disposable = testServer.auth.users.create('可删除用户');
    const deleted = await fetch(`${baseURL}/api/workbench/user/${disposable.userId}`, { method: 'DELETE' });
    expect(deleted.status).toBe(204);
    expect(testServer.auth.users.get(disposable.userId)).toBeUndefined();

    const bound = testServer.auth.users.create('已授权用户');
    testServer.auth.devices.authorize('bound-device', bound.userId);
    const deleteBound = await fetch(`${baseURL}/api/workbench/user/${bound.userId}`, { method: 'DELETE' });
    expect(deleteBound.status).toBe(409);
    expect(testServer.auth.users.get(bound.userId)).toBeDefined();
  });

  it('rejects user deletion from remote and anonymous actors', async () => {
    const remote = testServer.auth.users.create('远程用户');
    testServer.auth.devices.authorize('remote-device', remote.userId);
    const remoteDelete = await fetch(`${baseURL}/api/workbench/user/${remote.userId}`, {
      method: 'DELETE',
      headers: { 'x-forwarded-for': '203.0.113.7', 'x-device-id': 'remote-device' },
    });
    expect(remoteDelete.status).toBe(403);
    await expect(remoteDelete.json()).resolves.toMatchObject({ error: { code: 'LOCAL_ONLY' } });

    const anonymousDelete = await fetch(`${baseURL}/api/workbench/user/${remote.userId}`, {
      method: 'DELETE',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    expect(anonymousDelete.status).toBe(403);
    await expect(anonymousDelete.json()).resolves.toMatchObject({ error: { code: 'DEVICE_NOT_AUTHORIZED' } });
    expect(testServer.auth.users.get(remote.userId)).toBeDefined();
  });

  it('lets an anonymous remote device request one existing user without exposing workbench data', async () => {
    const requestedUser = testServer.auth.users.create('远程申请用户');
    const otherUser = testServer.auth.users.create('其他用户');
    const remoteHeaders = { 'x-forwarded-for': '203.0.113.9', 'x-device-id': 'remote-login-device' };

    const initialStatus = await fetch(`${baseURL}/api/auth/status?deviceId=remote-login-device`, { headers: remoteHeaders });
    await expect(initialStatus.json()).resolves.toMatchObject({ status: 'unauthorized' });
    expect(testServer.auth.pending.get('remote-login-device')).toBeUndefined();

    const usersResponse = await fetch(`${baseURL}/api/auth/users`, { headers: remoteHeaders });
    const usersPayload = await usersResponse.json() as { users: Array<Record<string, unknown>> };
    expect(usersResponse.status).toBe(200);
    expect(usersPayload.users).toContainEqual({ userId: requestedUser.userId, displayName: requestedUser.displayName });
    expect(Object.keys(usersPayload.users.find((user) => user.userId === requestedUser.userId)!).sort()).toEqual(['displayName', 'userId']);
    expect(JSON.stringify(usersPayload)).not.toContain('sessionId');

    const unknownRequest = await fetch(`${baseURL}/api/auth/request`, {
      method: 'POST', headers: { ...remoteHeaders, 'content-type': 'application/json', 'x-device-id': 'unknown-user-device' },
      body: JSON.stringify({ userId: 'missing-user' }),
    });
    expect(unknownRequest.status).toBe(404);
    expect(testServer.auth.pending.get('unknown-user-device')).toBeUndefined();

    const request = await fetch(`${baseURL}/api/auth/request`, {
      method: 'POST', headers: { ...remoteHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ userId: requestedUser.userId }),
    });
    expect(request.status).toBe(201);
    await expect(request.json()).resolves.toMatchObject({
      status: 'pending', requestedUser: { userId: requestedUser.userId, displayName: requestedUser.displayName },
    });

    const idempotentRequest = await fetch(`${baseURL}/api/auth/request`, {
      method: 'POST', headers: { ...remoteHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ userId: requestedUser.userId }),
    });
    expect(idempotentRequest.status).toBe(201);
    const conflictingRequest = await fetch(`${baseURL}/api/auth/request`, {
      method: 'POST', headers: { ...remoteHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ userId: otherUser.userId }),
    });
    expect(conflictingRequest.status).toBe(409);
    expect(testServer.auth.pending.get('remote-login-device')?.requestedUserId).toBe(requestedUser.userId);

    const mismatchStatus = await fetch(`${baseURL}/api/auth/status?deviceId=another-device`, { headers: remoteHeaders });
    expect(mismatchStatus.status).toBe(400);

    const userOverride = await fetch(`${baseURL}/api/auth/approve/remote-login-device`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: otherUser.userId }),
    });
    expect(userOverride.status).toBe(409);
    const nameOverride = await fetch(`${baseURL}/api/auth/approve/remote-login-device`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: '替代用户' }),
    });
    expect(nameOverride.status).toBe(409);

    const deletePendingUser = await fetch(`${baseURL}/api/workbench/user/${requestedUser.userId}`, { method: 'DELETE' });
    expect(deletePendingUser.status).toBe(409);

    const approve = await fetch(`${baseURL}/api/auth/approve/remote-login-device`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(approve.status).toBe(200);
    await expect(approve.json()).resolves.toMatchObject({ userId: requestedUser.userId });

    const noPending = await fetch(`${baseURL}/api/auth/approve/no-pending-device`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(noPending.status).toBe(404);

    const lastSeenAt = testServer.auth.devices.get('remote-login-device')!.lastSeenAt;
    const authorizedStatus = await fetch(`${baseURL}/api/auth/status?deviceId=remote-login-device`, { headers: remoteHeaders });
    await expect(authorizedStatus.json()).resolves.toMatchObject({
      status: 'authorized', user: { userId: requestedUser.userId, displayName: requestedUser.displayName },
    });
    expect(testServer.auth.devices.get('remote-login-device')!.lastSeenAt).toBe(lastSeenAt);

    const switchRequest = await fetch(`${baseURL}/api/auth/request`, {
      method: 'POST', headers: { ...remoteHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ userId: otherUser.userId }),
    });
    expect(switchRequest.status).toBe(409);
    expect(testServer.auth.pending.get('remote-login-device')).toBeUndefined();

    const remotePendingList = await fetch(`${baseURL}/api/auth/pending`, { headers: remoteHeaders });
    expect(remotePendingList.status).toBe(403);
    const wrongUsersMethod = await fetch(`${baseURL}/api/auth/users`, { method: 'POST', headers: remoteHeaders });
    expect(wrongUsersMethod.status).toBe(403);
    const wrongRequestMethod = await fetch(`${baseURL}/api/auth/request`, { headers: remoteHeaders });
    expect(wrongRequestMethod.status).toBe(403);
  });

  it('refuses approval when the requested user disappears', async () => {
    const user = testServer.auth.users.create('即将删除的用户');
    const request = await fetch(`${baseURL}/api/auth/request`, {
      method: 'POST',
      headers: {
        'x-forwarded-for': '203.0.113.10',
        'x-device-id': 'deleted-request-user-device',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ userId: user.userId }),
    });
    expect(request.status).toBe(201);
    testServer.auth.users.delete(user.userId);

    const approve = await fetch(`${baseURL}/api/auth/approve/deleted-request-user-device`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(approve.status).toBe(404);
    expect(testServer.auth.devices.get('deleted-request-user-device')).toBeUndefined();
  });

  it('DELETE /api/session/:id disposes the runtime and deletes persistent state', async () => {
    const createResponse = await fetch(`${baseURL}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'delete-runtime' }),
    });
    expect(createResponse.status).toBe(201);
    expect(testServer.editorMap.has('delete-runtime')).toBe(true);

    const deleteResponse = await fetch(`${baseURL}/api/session/delete-runtime`, {
      method: 'DELETE',
    });

    expect(deleteResponse.status).toBe(204);
    expect(testServer.editorMap.has('delete-runtime')).toBe(false);
    expect(testServer.manager.get('delete-runtime')).toBeUndefined();
  });

  it('completes a browser-targeted request through SSE and the result API', async () => {
    const sessionId = 'browser-request-e2e';
    const createResponse = await fetch(`${baseURL}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    expect(createResponse.status).toBe(201);

    testServer.editorMap.get(sessionId)!.message.registerRequest(
      'browser',
      'render',
      () => undefined,
      'browser',
      ['panel.render'],
    );
    const write = vi.fn((_chunk: string) => true);
    const response = new Writable() as unknown as ServerResponse;
    response.write = write as unknown as ServerResponse['write'];
    testServer.channel.addClient(sessionId, response);

    const requestPromise = fetch(`${baseURL}/api/message/request?sessionId=${sessionId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        plugin: 'browser',
        name: 'render',
        args: ['@scope/view.main', { id: 1 }],
      }),
    });

    let payload: Record<string, unknown> | undefined;
    for (let index = 0; index < 20 && !payload; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      payload = write.mock.calls
        .map(([chunk]) => JSON.parse(String(chunk).replace(/^data: /, '').trim()) as Record<string, unknown>)
        .find((event) => event.panel === '@scope/view.main' && event.method === 'render');
    }
    expect(payload).toMatchObject({
      protocolVersion: 1,
      type: 'panel-dispatch',
      panel: '@scope/view.main',
      method: 'render',
      args: [{ id: 1 }],
    });

    const mismatch = await fetch(`${baseURL}/api/message/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'another-session',
        requestId: payload!.requestId,
        result: { ok: true, value: 'wrong' },
      }),
    });
    expect(mismatch.status).toBe(409);

    const resultResponse = await fetch(`${baseURL}/api/message/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        requestId: payload!.requestId,
        result: { ok: true, value: 'browser-value' },
      }),
    });
    expect(resultResponse.status).toBe(204);

    const completed = await requestPromise;
    expect(completed.status).toBe(200);
    expect(await completed.json()).toEqual({ result: 'browser-value' });

    const duplicate = await fetch(`${baseURL}/api/message/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        requestId: payload!.requestId,
        result: { ok: true, value: 'late' },
      }),
    });
    expect(duplicate.status).toBe(404);
  });

  it.each([
    '/api/menu/trigger',
    '/api/message/request',
    '/api/message/broadcast',
    '/api/message/result',
    '/api/panel/open',
    '/api/panel-instance/close',
    '/api/window-group/close',
    '/api/i18n?sessionId=e2e-test',
  ])('POST %s returns the shared INVALID_JSON response', async (route) => {
    const response = await fetch(`${baseURL}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'INVALID_JSON' },
    });
  });

  it.each([
    '/api/bootstrap/missing-session',
    '/api/window-entry/main?sessionId=missing-session',
  ])('GET %s returns the shared SESSION_NOT_FOUND response', async (route) => {
    const response = await fetch(`${baseURL}${route}`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: 'SESSION_NOT_FOUND' },
    });
  });

  it('distinguishes a missing message route from a failing handler', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await fetch(`${baseURL}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'message-errors' }),
    });
    const editor = testServer.editorMap.get('message-errors')!;
    editor.message.registerRequest('explode', 'run', () => {
      throw new Error('handler exploded');
    });

    const missing = await fetch(`${baseURL}/api/message/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'message-errors', plugin: 'missing', name: 'route', args: [],
      }),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: { code: 'MESSAGE_ROUTE_NOT_FOUND' },
    });

    const failed = await fetch(`${baseURL}/api/message/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'message-errors', plugin: 'explode', name: 'run', args: [],
      }),
    });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({
      error: { code: 'MESSAGE_REQUEST_FAILED', message: 'handler exploded', details: null },
    });
    consoleError.mockRestore();
  });

  it('GET /sse/:sessionId returns text/event-stream with connected event', async () => {
    const resp = await fetch(`${baseURL}/sse/e2e-test`);

    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/event-stream');
    expect(resp.headers.get('cache-control')).toBe('no-cache');
    expect(resp.headers.get('connection')).toBe('keep-alive');

    // Read the first SSE event (connected event)
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let firstEvent = '';

    // Read until we get the first complete SSE event
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      firstEvent += decoder.decode(value, { stream: true });
      if (firstEvent.includes('\n\n')) break;
    }
    reader.cancel();

    expect(firstEvent).toContain('data:');
    expect(firstEvent).toContain('"type":"connected"');
    expect(firstEvent).toContain('e2e-test');
  });
});
