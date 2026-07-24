import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createClientAssetRouter } from '../../src/routes/client-asset';
import { createServer } from '../../src/server';

const temporaryDirectories: string[] = [];

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'harbors-client-assets-'));
  temporaryDirectories.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const filename = path.join(root, relative);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, contents);
  }
  return root;
}

async function responseFrom(
  router: ReturnType<typeof createClientAssetRouter>,
  method: string,
  url: string,
) {
  const chunks: Buffer[] = [];
  const headers = new Map<string, string>();
  const response = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  }) as unknown as ServerResponse;
  response.statusCode = 404;
  response.setHeader = (name, value) => {
    headers.set(name.toLowerCase(), String(value));
    return response;
  };
  response.getHeader = (name) => headers.get(name.toLowerCase());
  const finished = new Promise<void>((resolve, reject) => {
    response.once('finish', resolve);
    response.once('error', reject);
  });
  const request = { method, url, headers: {} } as IncomingMessage;
  const handled = await router(request, response);
  if (!handled) response.end();
  await finished;
  return {
    handled,
    status: response.statusCode,
    body: Buffer.concat(chunks).toString('utf8'),
    contentType: headers.get('content-type'),
    contentLength: headers.get('content-length'),
    nosniff: headers.get('x-content-type-options'),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('createClientAssetRouter', () => {
  it('serves built assets and index without escaping the Client root', async () => {
    const root = fixture({
      'index.html': '<script src="/assets/index.js"></script>',
      'assets/index.js': 'export const ready = true;',
    });
    const router = createClientAssetRouter(root);

    const asset = await responseFrom(router, 'GET', '/assets/index.js');
    expect(asset).toMatchObject({
      handled: true,
      status: 200,
      body: 'export const ready = true;',
      contentLength: String(Buffer.byteLength('export const ready = true;')),
      nosniff: 'nosniff',
    });
    expect(asset.contentType).toContain('application/javascript');

    const head = await responseFrom(router, 'HEAD', '/assets/index.js');
    expect(head).toMatchObject({
      handled: true,
      status: 200,
      body: '',
      contentLength: String(Buffer.byteLength('export const ready = true;')),
    });
    expect(head.contentType).toContain('application/javascript');

    const spa = await responseFrom(router, 'GET', '/workspace/one');
    expect(spa).toMatchObject({
      handled: true,
      status: 200,
      body: '<script src="/assets/index.js"></script>',
      nosniff: 'nosniff',
    });
    expect(spa.contentType).toContain('text/html');

    await expect(responseFrom(router, 'GET', '/assets/%2e%2e/index.html')).resolves.toMatchObject({
      handled: true,
      status: 404,
      body: '',
    });
    await expect(responseFrom(router, 'POST', '/')).resolves.toMatchObject({
      handled: false,
      status: 404,
      body: '',
    });
  });

  it('returns 404 for malformed, absolute, directory, NUL, and missing asset paths', async () => {
    const root = fixture({
      'index.html': '<div id="app"></div>',
      'assets/nested/index.js': 'export const nested = true;',
    });
    const router = createClientAssetRouter(root);

    for (const url of [
      '/assets/%',
      '/assets/%00index.js',
      '/assets/%2Fnested/index.js',
      '/assets/nested/',
      '/assets/missing.js',
    ]) {
      await expect(responseFrom(router, 'GET', url), url).resolves.toMatchObject({
        handled: true,
        status: 404,
        body: '',
      });
    }
  });

  it('rejects asset symlinks whose real target leaves the Client root', async () => {
    const root = fixture({
      'index.html': '<div id="app"></div>',
      'outside.js': 'export const secret = true;',
    });
    const clientRoot = path.join(root, 'client');
    mkdirSync(path.join(clientRoot, 'assets'), { recursive: true });
    writeFileSync(path.join(clientRoot, 'index.html'), '<div id="client"></div>');
    symlinkSync(path.join(root, 'outside.js'), path.join(clientRoot, 'assets', 'index.js'));
    const router = createClientAssetRouter(clientRoot);

    await expect(responseFrom(router, 'GET', '/assets/index.js')).resolves.toMatchObject({
      handled: true,
      status: 404,
      body: '',
    });
  });

  it('dispatches API routes before production assets and uses the SPA only for non-API routes', async () => {
    const root = fixture({
      'index.html': '<main>production client</main>',
      'assets/index.js': 'export const ready = true;',
    });
    const applicationRuntime = {
      start: async () => ({}),
      getBootstrap: () => ({}),
      triggerMenu: async () => undefined,
      subscribe: () => () => undefined,
      dispose: async () => undefined,
    } as never;
    const server = createServer({
      clientAssetsRoot: root,
      applicationRuntime,
      host: '127.0.0.1',
    });

    try {
      const port = await server.start(0);
      const api = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(api.status).toBe(200);
      expect(api.headers.get('content-type')).toBe('application/json');
      await expect(api.json()).resolves.toMatchObject({ status: 'ok' });

      const spa = await fetch(`http://127.0.0.1:${port}/workspace/one`);
      expect(spa.status).toBe(200);
      expect(spa.headers.get('content-type')).toContain('text/html');
      await expect(spa.text()).resolves.toBe('<main>production client</main>');
    } finally {
      await server.stop();
    }
  });
});
