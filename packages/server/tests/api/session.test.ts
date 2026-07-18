import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSessionRouter } from '../../src/api/session';
import { SessionManager } from '../../src/session/manager';
import { SessionStore } from '../../src/session/store';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HttpError } from '../../src/http/errors';
import { sendHttpError } from '../../src/http/json';

function mockReq(method: string, url: string, body?: object | string | Buffer): IncomingMessage {
  const readable = new Readable({
    read() {
      if (body !== undefined) {
        this.push(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
      }
      this.push(null);
    },
  });
  return Object.assign(readable, {
    method,
    url,
    headers: {},
  }) as unknown as IncomingMessage;
}

async function invoke(
  router: ReturnType<typeof createSessionRouter>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    await router(req, res);
  } catch (error) {
    if (error instanceof HttpError) {
      sendHttpError(res, error);
      return;
    }
    throw error;
  }
}

function mockRes(): { res: ServerResponse; body: () => Promise<string>; statusCode: () => number } {
  const chunks: Buffer[] = [];
  const res = {
    statusCode: 200,
    setHeader: () => {},
    end: (data?: string) => {
      if (data) chunks.push(Buffer.from(data));
    },
    writeHead: (code: number) => { res.statusCode = code; },
  } as unknown as ServerResponse;

  return {
    res,
    body: async () => Buffer.concat(chunks).toString(),
    statusCode: () => res.statusCode,
  };
}

describe('Session API Routes', () => {
  let router: ReturnType<typeof createSessionRouter>;
  let manager: SessionManager;
  let store: SessionStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `editor-api-test-${Date.now()}.db`);
    store = new SessionStore(dbPath);
    manager = new SessionManager(store);
    router = createSessionRouter(manager);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('GET /api/session/:id returns 404 for unknown session', async () => {
    const req = mockReq('GET', '/api/session/unknown');
    const { res, body, statusCode } = mockRes();

    await invoke(router, req, res);
    const data = JSON.parse(await body());

    expect(statusCode()).toBe(404);
    expect(data.error).toBeDefined();
  });

  it('GET /api/session/:id returns session info', async () => {
    manager.getOrCreate('test-session', '/home/user/test');

    const req = mockReq('GET', '/api/session/test-session');
    const { res, body } = mockRes();

    await invoke(router, req, res);
    const data = JSON.parse(await body());

    expect(data.sessionId).toBe('test-session');
    expect(data.workspacePath).toBe('/home/user/test');
    expect(data.savedFileList).toEqual([]);
  });

  it('POST /api/session creates a new session', async () => {
    const req = mockReq('POST', '/api/session', { workspacePath: '/tmp/new' });
    const { res, body } = mockRes();

    await invoke(router, req, res);
    const data = JSON.parse(await body());

    expect(data.sessionId).toBeDefined();
    expect(data.workspacePath).toBe('/tmp/new');
  });

  it('POST /api/session sets a custom sessionId', async () => {
    const req = mockReq('POST', '/api/session', {
      sessionId: 'custom-id',
      workspacePath: '/tmp/custom',
    });
    const { res, body } = mockRes();

    await invoke(router, req, res);
    const data = JSON.parse(await body());

    expect(data.sessionId).toBe('custom-id');
  });

  it('POST /api/session returns INVALID_JSON for malformed input', async () => {
    const req = mockReq('POST', '/api/session', '{bad');
    const { res, body, statusCode } = mockRes();

    await invoke(router, req, res);

    expect(statusCode()).toBe(400);
    expect(JSON.parse(await body())).toMatchObject({
      error: { code: 'INVALID_JSON' },
    });
  });

  it('DELETE /api/session/:id runs runtime cleanup and deletes the session', async () => {
    manager.getOrCreate('delete-me');
    const cleanup = async (sessionId: string) => {
      manager.destroy(sessionId);
      return true;
    };
    const routerWithDelete = (createSessionRouter as unknown as (
      manager: SessionManager,
      onCreated: undefined,
      onDeleted: (sessionId: string) => Promise<boolean>,
    ) => ReturnType<typeof createSessionRouter>)(manager, undefined, cleanup);
    const { res, body, statusCode } = mockRes();

    await invoke(routerWithDelete, mockReq('DELETE', '/api/session/delete-me'), res);

    expect(statusCode()).toBe(204);
    expect(await body()).toBe('');
    expect(manager.get('delete-me')).toBeUndefined();
  });

  it('DELETE /api/session/:id returns SESSION_NOT_FOUND for a missing session', async () => {
    const cleanup = async () => false;
    const routerWithDelete = (createSessionRouter as unknown as (
      manager: SessionManager,
      onCreated: undefined,
      onDeleted: (sessionId: string) => Promise<boolean>,
    ) => ReturnType<typeof createSessionRouter>)(manager, undefined, cleanup);
    const { res, body, statusCode } = mockRes();

    await invoke(routerWithDelete, mockReq('DELETE', '/api/session/missing'), res);

    expect(statusCode()).toBe(404);
    expect(JSON.parse(await body())).toMatchObject({
      error: { code: 'SESSION_NOT_FOUND' },
    });
  });
});
