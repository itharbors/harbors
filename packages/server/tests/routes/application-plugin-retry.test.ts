import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import type { ApplicationBootstrap } from '../../src/application/types';
import { createApp } from '../../src/app';
import { HttpError } from '../../src/http/errors';
import { sendHttpError } from '../../src/http/json';
import { createApplicationPluginRetryRouter } from '../../src/routes/application-plugin-retry';
import { testAssembly } from '../helpers/assembly';
import { createTestPluginPathRoots } from '../helpers/plugin-paths';

const controlHeaders = {
  'content-type': 'application/json',
  'x-harbors-application-token': 'launch-secret',
};

const readyBootstrap: ApplicationBootstrap = {
  phase: 'ready',
  plugins: [{
    name: '@scope/running',
    path: '/public/application-plugin',
    kits: ['@scope/kit'],
    status: 'running',
  }],
  diagnostics: [],
  menu: { tree: [], warnings: [] },
};

describe('application plugin retry route', () => {
  it('allows only POST on the fixed retry path', async () => {
    const router = createApplicationPluginRetryRouter(
      { retryPlugin: vi.fn() },
      { controlToken: 'launch-secret' },
    );

    await expect(router(request('GET', '/api/application/plugin/retry'), response().res))
      .rejects.toMatchObject({ status: 405, code: 'METHOD_NOT_ALLOWED' });
    await expect(router(request('POST', '/api/application/plugin/retry/extra'), response().res))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('requires the JSON media type before reading the body', async () => {
    const retryPlugin = vi.fn();
    const router = createApplicationPluginRetryRouter(
      { retryPlugin },
      { controlToken: 'launch-secret' },
    );

    await expect(router(request('POST', '/api/application/plugin/retry', {
      plugin: '@scope/failed',
    }, {
      'content-type': 'text/plain',
      'x-harbors-application-token': 'launch-secret',
    }), response().res)).rejects.toMatchObject({ status: 415, code: 'CONTENT_TYPE_REQUIRED' });
    expect(retryPlugin).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['wrong', 'wrong-secret'],
  ])('rejects a %s application mutation token', async (_case, token) => {
    const retryPlugin = vi.fn();
    const router = createApplicationPluginRetryRouter(
      { retryPlugin },
      { controlToken: 'launch-secret' },
    );

    await expect(router(request('POST', '/api/application/plugin/retry', {
      plugin: '@scope/failed',
    }, {
      'content-type': 'application/json',
      ...(token ? { 'x-harbors-application-token': token } : {}),
    }), response().res)).rejects.toMatchObject({ status: 403, code: 'APPLICATION_CONTROL_FORBIDDEN' });
    expect(retryPlugin).not.toHaveBeenCalled();
  });

  it('fails closed when no application mutation token is configured', async () => {
    const retryPlugin = vi.fn();
    const router = createApplicationPluginRetryRouter({ retryPlugin });

    await expect(router(request('POST', '/api/application/plugin/retry', {
      plugin: '@scope/failed',
    }, controlHeaders), response().res)).rejects.toMatchObject({
      status: 403,
      code: 'APPLICATION_CONTROL_FORBIDDEN',
    });
    expect(retryPlugin).not.toHaveBeenCalled();
  });

  it('rejects browser-originated retry mutations', async () => {
    const retryPlugin = vi.fn();
    const router = createApplicationPluginRetryRouter(
      { retryPlugin },
      { controlToken: 'launch-secret' },
    );

    await expect(router(request('POST', '/api/application/plugin/retry', {
      plugin: '@scope/failed',
    }, { ...controlHeaders, origin: 'https://attacker.example' }), response().res))
      .rejects.toMatchObject({ status: 403, code: 'BROWSER_ORIGIN_FORBIDDEN' });
    expect(retryPlugin).not.toHaveBeenCalled();
  });

  it('accepts only the exact plugin body field', async () => {
    const retryPlugin = vi.fn();
    const router = createApplicationPluginRetryRouter(
      { retryPlugin },
      { controlToken: 'launch-secret' },
    );

    await expect(router(request('POST', '/api/application/plugin/retry', {
      plugin: '@scope/failed',
      path: '/private/plugin.js',
    }, controlHeaders), response().res)).rejects.toMatchObject({ status: 400, code: 'INVALID_REQUEST' });
    expect(retryPlugin).not.toHaveBeenCalled();
  });

  it.each([
    '',
    'scope/name',
    '@scope',
    '@scope/',
    '@/name',
    '@scope/../secret',
    '@Scope/name',
    '@scope/name/extra',
    ' @scope/name',
  ])('rejects invalid plugin identity %j', async (plugin) => {
    const retryPlugin = vi.fn();
    const router = createApplicationPluginRetryRouter(
      { retryPlugin },
      { controlToken: 'launch-secret' },
    );

    await expect(router(request('POST', '/api/application/plugin/retry', { plugin }, controlHeaders), response().res))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_REQUEST' });
    expect(retryPlugin).not.toHaveBeenCalled();
  });

  it('uses the shared bounded JSON body reader', async () => {
    const retryPlugin = vi.fn();
    const router = createApplicationPluginRetryRouter(
      { retryPlugin },
      { controlToken: 'launch-secret' },
    );
    const oversized = JSON.stringify({ plugin: `@scope/${'a'.repeat(1024 * 1024)}` });

    await expect(router(request('POST', '/api/application/plugin/retry', oversized, controlHeaders), response().res))
      .rejects.toMatchObject({ status: 413, code: 'BODY_TOO_LARGE' });
    expect(retryPlugin).not.toHaveBeenCalled();
  });

  it('maps an unknown plugin to a stable secret-free 404', async () => {
    const retryPlugin = vi.fn(async () => {
      throw Object.assign(new Error('missing /private/plugin.js owner-secret stderr stack'), {
        code: 'APPLICATION_PLUGIN_UNAVAILABLE',
        plugin: '@scope/missing',
      });
    });
    const router = createApplicationPluginRetryRouter(
      { retryPlugin },
      { controlToken: 'launch-secret' },
    );
    const result = response();

    await invoke(router, request('POST', '/api/application/plugin/retry', {
      plugin: '@scope/missing',
    }, controlHeaders), result.res);

    expect(result.res.statusCode).toBe(404);
    expect(JSON.parse(result.text())).toEqual({
      error: { code: 'APPLICATION_PLUGIN_NOT_FOUND', message: 'Application plugin not found', details: null },
    });
    expect(result.text()).not.toMatch(/launch-secret|owner-secret|private|stderr|stack/u);
  });

  it('returns the sanitized bootstrap after restarting a running plugin', async () => {
    const retryPlugin = vi.fn(async () => readyBootstrap);
    const router = createApplicationPluginRetryRouter(
      { retryPlugin },
      { controlToken: 'launch-secret' },
    );
    const result = response();

    await router(request('POST', '/api/application/plugin/retry', {
      plugin: '@scope/running',
    }, controlHeaders), result.res);

    expect(result.res.statusCode).toBe(200);
    expect(JSON.parse(result.text())).toEqual(readyBootstrap);
  });

  it('returns a sanitized degraded bootstrap when an explicit fused retry remains failed', async () => {
    const fusedBootstrap: ApplicationBootstrap = {
      ...readyBootstrap,
      phase: 'degraded',
      plugins: [{
        name: '@scope/fused',
        path: '/public/application-plugin',
        kits: ['@scope/kit'],
        status: 'failed',
        errorCode: 'APPLICATION_PLUGIN_PROCESS_FAILED',
      }],
    };
    const retryPlugin = vi.fn(async () => fusedBootstrap);
    const router = createApplicationPluginRetryRouter(
      { retryPlugin },
      { controlToken: 'launch-secret' },
    );
    const result = response();

    await router(request('POST', '/api/application/plugin/retry', {
      plugin: '@scope/fused',
    }, controlHeaders), result.res);

    expect(result.res.statusCode).toBe(200);
    expect(JSON.parse(result.text())).toEqual(fusedBootstrap);
    expect(result.text()).not.toMatch(/owner-secret|entry\.js|stderr|stack/u);
  });

  it('maps an unavailable runtime to a stable secret-free 503', async () => {
    const retryPlugin = vi.fn(async () => {
      throw Object.assign(new Error('shutdown /private/plugin.js owner-secret stderr stack'), {
        code: 'APPLICATION_RUNTIME_UNAVAILABLE',
      });
    });
    const router = createApplicationPluginRetryRouter(
      { retryPlugin },
      { controlToken: 'launch-secret' },
    );
    const result = response();

    await invoke(router, request('POST', '/api/application/plugin/retry', {
      plugin: '@scope/failed',
    }, controlHeaders), result.res);

    expect(result.res.statusCode).toBe(503);
    expect(JSON.parse(result.text())).toEqual({
      error: { code: 'APPLICATION_RUNTIME_UNAVAILABLE', message: 'Application runtime is unavailable', details: null },
    });
    expect(result.text()).not.toMatch(/launch-secret|owner-secret|private|stderr|stack/u);
  });

  it('leaves unexpected failures to the generic secret-free HTTP boundary', async () => {
    const retryPlugin = vi.fn(async () => {
      throw new Error('bootstrap failed /private/plugin.js owner-secret stderr stack');
    });
    const router = createApplicationPluginRetryRouter(
      { retryPlugin },
      { controlToken: 'launch-secret' },
    );
    const result = response();

    await invoke(router, request('POST', '/api/application/plugin/retry', {
      plugin: '@scope/failed',
    }, controlHeaders), result.res);

    expect(result.res.statusCode).toBe(500);
    expect(JSON.parse(result.text())).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error', details: null },
    });
    expect(result.text()).not.toMatch(/launch-secret|owner-secret|private|stderr|stack/u);
  });

  it('is registered ahead of the legacy API fallback', async () => {
    const retryPlugin = vi.fn(async () => {
      throw Object.assign(new Error('Application plugin is unavailable'), {
        code: 'APPLICATION_PLUGIN_UNAVAILABLE',
        plugin: '@scope/missing',
      });
    });
    const app = createApp(
      { get: vi.fn(), getOrCreate: vi.fn(), destroy: vi.fn() } as never,
      {
        onSessionDisconnected: vi.fn(() => () => undefined),
        broadcast: vi.fn(),
        closeSession: vi.fn(),
      } as never,
      {
        assembly: testAssembly,
        applicationRuntime: {
          getBootstrap: vi.fn(() => readyBootstrap),
          request: vi.fn(),
          retryPlugin,
          triggerMenu: vi.fn(),
          subscribe: vi.fn(() => () => undefined),
        },
        applicationControlToken: 'launch-secret',
        pluginPathRoots: createTestPluginPathRoots(),
      } as never,
    );
    const result = response();

    await app.handleRequest(request('POST', '/api/application/plugin/retry', {
      plugin: '@scope/missing',
    }, controlHeaders), result.res);

    expect(result.res.statusCode).toBe(404);
    expect(JSON.parse(result.text())).toMatchObject({
      error: { code: 'APPLICATION_PLUGIN_NOT_FOUND' },
    });
    expect(retryPlugin).toHaveBeenCalledWith('@scope/missing');
  });
});

function request(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): IncomingMessage {
  const stream = new Readable({
    read() {
      if (body !== undefined) this.push(typeof body === 'string' ? body : JSON.stringify(body));
      this.push(null);
    },
  });
  return Object.assign(stream, { method, url, headers }) as IncomingMessage;
}

function response() {
  const chunks: string[] = [];
  const emitter = new EventEmitter();
  const res = Object.assign(emitter, {
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn((chunk?: string) => {
      if (chunk) chunks.push(String(chunk));
    }),
  }) as unknown as ServerResponse;
  return { res, text: () => chunks.join('') };
}

async function invoke(
  router: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    await router(req, res);
  } catch (error) {
    sendHttpError(res, error instanceof HttpError
      ? error
      : new HttpError(500, 'INTERNAL_ERROR', 'Internal server error'));
  }
}
