import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from '../src/server';
import type { ServerResponse } from 'node:http';
import { Writable } from 'node:stream';

describe('Server Integration', () => {
  let port: number;
  let stop: () => Promise<void>;
  let baseURL: string;
  let testServer: ReturnType<typeof createServer>;

  beforeAll(async () => {
    testServer = createServer();
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
    expect(await failed.json()).toMatchObject({
      error: { code: 'INTERNAL_ERROR' },
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
