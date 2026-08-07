import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { createServer } from '../../src/server';
import {
  createLocalWebFileRouter,
  isLoopbackWebOrigin,
  LocalWebFileStore,
} from '../../src/routes/local-web-file';
import type { SessionManager } from '../../src/session/manager';
import { testAssembly } from '../helpers/assembly';
import { createTestPluginPathRoots } from '../helpers/plugin-paths';

describe('local Web file route', () => {
  const applicationData = fs.mkdtempSync(path.join(os.tmpdir(), 'harbors-local-web-file-'));
  const server = createServer({
    assembly: testAssembly,
    pluginPathRoots: createTestPluginPathRoots(applicationData),
  });
  let baseUrl = '';
  let shutdownStagedPath = '';

  beforeAll(async () => {
    const port = await server.start(0);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server.stop();
    expect(fs.existsSync(shutdownStagedPath)).toBe(false);
    await fsp.rm(applicationData, { recursive: true, force: true });
  });

  it.each([
    'http://localhost:49380',
    'https://workspace.localhost:49380',
    'http://127.0.0.1:49380',
    'http://127.23.4.5:49380',
    'http://[::1]:49380',
  ])('accepts loopback browser origin %s', (origin) => {
    expect(isLoopbackWebOrigin(origin)).toBe(true);
  });

  it.each([
    undefined,
    'null',
    'file://',
    'http://192.168.1.5:49380',
    'https://harbors.example.com',
  ])('rejects non-loopback browser origin %s', (origin) => {
    expect(isLoopbackWebOrigin(origin)).toBe(false);
  });

  it('stages a selected file as a read-only session copy and removes it with the session', async () => {
    const sessionId = 'local-file-session';
    server.manager.getOrCreate(sessionId);

    const contents = Buffer.from('SQLite format 3\0test payload');
    const upload = await fetch(
      `${baseUrl}/api/local-file/open/${sessionId}?name=${encodeURIComponent('../sample.sqlite')}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          origin: 'http://localhost:49380',
        },
        body: contents,
      },
    );
    const result = await upload.json() as { path: string; size: number; access: string };

    expect(upload.status).toBe(201);
    expect(result).toMatchObject({ size: contents.length, access: 'readonly-copy' });
    expect(path.basename(result.path)).toBe('sample.sqlite');
    await expect(fsp.readFile(result.path)).resolves.toEqual(contents);
    expect((await fsp.stat(result.path)).mode & 0o222).toBe(0);

    const remove = await fetch(`${baseUrl}/api/session/${sessionId}`, { method: 'DELETE' });
    expect(remove.status).toBe(204);
    expect(fs.existsSync(result.path)).toBe(false);
  });

  it('rejects remote Web origins before invoking the file store', async () => {
    const stage = vi.fn();
    const router = createLocalWebFileRouter(
      { get: vi.fn(() => ({ sessionId: 'remote' })) } as unknown as SessionManager,
      { stage } as unknown as LocalWebFileStore,
    );
    const request = {
      method: 'POST',
      url: '/api/local-file/open/remote?name=data.sqlite',
      headers: {
        origin: 'http://192.168.1.8:49380',
        'content-type': 'application/octet-stream',
      },
    } as IncomingMessage;

    await expect(router(request, {} as ServerResponse)).rejects.toMatchObject({
      status: 403,
      code: 'REMOTE_LOCAL_FILE_FORBIDDEN',
    });
    expect(stage).not.toHaveBeenCalled();
  });

  it('rejects uploads for unknown sessions', async () => {
    const response = await fetch(`${baseUrl}/api/local-file/open/missing?name=data.sqlite`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        origin: 'http://localhost:49380',
      },
      body: Buffer.from('x'),
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'SESSION_NOT_FOUND' },
    });
  });

  it('removes remaining staged files when the Server stops', async () => {
    const sessionId = 'server-stop-file-session';
    server.manager.getOrCreate(sessionId);
    const response = await fetch(
      `${baseUrl}/api/local-file/open/${sessionId}?name=shutdown.sqlite`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          origin: 'http://localhost:49380',
        },
        body: Buffer.from('shutdown fixture'),
      },
    );
    const result = await response.json() as { path: string };
    expect(response.status).toBe(201);
    shutdownStagedPath = result.path;
    expect(fs.existsSync(shutdownStagedPath)).toBe(true);
  });

  it('enforces the streaming byte limit and removes partial files', async () => {
    const rootDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbors-local-limit-'));
    const store = new LocalWebFileStore({ rootDirectory, maxBytes: 3 });
    const request = Readable.from([Buffer.from('four')]) as IncomingMessage;
    request.headers = {};

    await expect(store.stage('limit-session', 'large.sqlite', request)).rejects.toMatchObject({
      status: 413,
      code: 'LOCAL_FILE_TOO_LARGE',
    });
    await store.dispose();
    const remaining = await fsp.readdir(rootDirectory);
    expect(remaining).toEqual([]);
    await fsp.rm(rootDirectory, { recursive: true, force: true });
  });
});
