import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createClientAssetRouter } from '../../src/routes/client-asset';

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
      nosniff: 'nosniff',
    });
    expect(asset.contentType).toContain('application/javascript');

    const head = await responseFrom(router, 'HEAD', '/assets/index.js');
    expect(head).toMatchObject({ handled: true, status: 200, body: '' });
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
});
