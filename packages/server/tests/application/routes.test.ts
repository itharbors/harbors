import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { HttpError } from '../../src/http/errors';
import { sendHttpError } from '../../src/http/json';
import { createApplicationBootstrapRouter } from '../../src/routes/application-bootstrap';
import { createApplicationEventsRouter } from '../../src/routes/application-events';
import { createApplicationMenuTriggerRouter } from '../../src/routes/application-menu-trigger';
import type { ApplicationBootstrap, ApplicationEvent } from '../../src/application/types';

function request(method: string, url: string, body?: unknown): IncomingMessage {
  const stream = new Readable({
    read() {
      if (body !== undefined) this.push(typeof body === 'string' ? body : JSON.stringify(body));
      this.push(null);
    },
  });
  return Object.assign(stream, { method, url, headers: {} }) as IncomingMessage;
}

function response() {
  const chunks: string[] = [];
  const emitter = new EventEmitter();
  const res = Object.assign(emitter, {
    statusCode: 200,
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }),
    end: vi.fn((chunk?: string) => {
      if (chunk) chunks.push(String(chunk));
    }),
  }) as unknown as ServerResponse;
  return { res, text: () => chunks.join('') };
}

const bootstrap: ApplicationBootstrap = {
  phase: 'ready',
  plugins: [],
  diagnostics: [],
  menu: { tree: [], warnings: [] },
};

async function invoke(
  router: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
  req: IncomingMessage,
  res: ServerResponse,
) {
  try {
    await router(req, res);
  } catch (error) {
    sendHttpError(res, error instanceof HttpError
      ? error
      : new HttpError(500, 'INTERNAL_ERROR', 'Internal server error'));
  }
}

describe('application routes', () => {
  it('returns the application bootstrap without a session id', async () => {
    const runtime = { getBootstrap: vi.fn(() => bootstrap) };
    const router = createApplicationBootstrapRouter(runtime);
    const { res, text } = response();

    await router(request('GET', '/api/application/bootstrap'), res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(text())).toEqual(bootstrap);
  });

  it('triggers application menu items and maps missing items to a stable 404', async () => {
    const runtime = {
      triggerMenu: vi.fn(async (menuId: string) => {
        if (menuId === 'missing') throw new Error('Menu item "missing" not found');
        return { menuId };
      }),
    };
    const router = createApplicationMenuTriggerRouter(runtime);
    const success = response();
    const missing = response();

    await invoke(router, request('POST', '/api/application/menu/trigger', { menuId: 'tools/install' }), success.res);
    await invoke(router, request('POST', '/api/application/menu/trigger', { menuId: 'missing' }), missing.res);

    expect(success.res.statusCode).toBe(200);
    expect(JSON.parse(success.text())).toEqual({ result: { menuId: 'tools/install' } });
    expect(missing.res.statusCode).toBe(404);
    expect(JSON.parse(missing.text())).toMatchObject({ error: { code: 'MENU_ITEM_NOT_FOUND' } });
  });

  it('streams an initial bootstrap and later application events', async () => {
    let listener: ((event: ApplicationEvent) => void) | undefined;
    const unsubscribe = vi.fn();
    const runtime = {
      getBootstrap: vi.fn(() => bootstrap),
      subscribe: vi.fn((next: (event: ApplicationEvent) => void) => {
        listener = next;
        return unsubscribe;
      }),
    };
    const router = createApplicationEventsRouter(runtime);
    const { res, text } = response();

    await router(request('GET', '/sse/application'), res);
    listener?.({ type: 'application-bootstrap', bootstrap: { ...bootstrap, phase: 'degraded' } });
    (res as unknown as EventEmitter).emit('close');

    expect(res.statusCode).toBe(200);
    expect(text()).toContain('"phase":"ready"');
    expect(text()).toContain('"phase":"degraded"');
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
