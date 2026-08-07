import type { IncomingMessage, ServerResponse } from 'node:http';
import { promises as fs, createWriteStream } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { SessionManager } from '../session/manager';
import { HttpError } from '../http/errors';
import { sendJson } from '../http/json';

export const MAX_LOCAL_WEB_FILE_BYTES = 2 * 1024 * 1024 * 1024;

export interface LocalWebFileStoreOptions {
  rootDirectory: string;
  maxBytes?: number;
}

export interface StagedLocalWebFile {
  path: string;
  size: number;
}

export class LocalWebFileStore {
  private readonly maxBytes: number;
  private runtimeRootPromise: Promise<string> | undefined;
  private readonly sessionDirectories = new Map<string, Promise<string>>();
  private readonly pending = new Map<string, Set<Promise<unknown>>>();

  constructor(private readonly options: LocalWebFileStoreOptions) {
    this.maxBytes = options.maxBytes ?? MAX_LOCAL_WEB_FILE_BYTES;
  }

  stage(
    sessionId: string,
    fileName: string,
    request: IncomingMessage,
  ): Promise<StagedLocalWebFile> {
    const operation = this.stageInternal(sessionId, fileName, request);
    const sessionPending = this.pending.get(sessionId) ?? new Set<Promise<unknown>>();
    sessionPending.add(operation);
    this.pending.set(sessionId, sessionPending);
    void operation.finally(() => {
      sessionPending.delete(operation);
      if (sessionPending.size === 0) this.pending.delete(sessionId);
    }).catch(() => undefined);
    return operation;
  }

  async cleanupSession(sessionId: string): Promise<void> {
    const pending = this.pending.get(sessionId);
    if (pending) await Promise.allSettled(pending);
    const directoryPromise = this.sessionDirectories.get(sessionId);
    this.sessionDirectories.delete(sessionId);
    if (!directoryPromise) return;
    const directory = await directoryPromise;
    await fs.rm(directory, { recursive: true, force: true });
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(Array.from(this.pending.values()).flatMap((items) => [...items]));
    this.pending.clear();
    this.sessionDirectories.clear();
    if (!this.runtimeRootPromise) return;
    const runtimeRoot = await this.runtimeRootPromise;
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }

  private async stageInternal(
    sessionId: string,
    fileName: string,
    request: IncomingMessage,
  ): Promise<StagedLocalWebFile> {
    assertContentLength(request.headers['content-length'], this.maxBytes);
    const sessionDirectory = await this.getSessionDirectory(sessionId);
    const uploadDirectory = await fs.mkdtemp(path.join(sessionDirectory, 'file-'));
    const safeName = sanitizeFileName(fileName);
    const finalPath = path.join(uploadDirectory, safeName);
    const partialPath = `${finalPath}.part`;
    let size = 0;
    const limiter = new Transform({
      transform: (chunk: Buffer | string, encoding, callback) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        size += buffer.length;
        if (size > this.maxBytes) {
          callback(fileTooLarge(this.maxBytes));
          return;
        }
        callback(null, buffer);
      },
    });

    try {
      await pipeline(
        request,
        limiter,
        createWriteStream(partialPath, { flags: 'wx', mode: 0o600 }),
      );
      await fs.chmod(partialPath, 0o400);
      await fs.rename(partialPath, finalPath);
      return { path: await fs.realpath(finalPath), size };
    } catch (error) {
      await Promise.allSettled([
        fs.rm(partialPath, { force: true }),
        fs.rm(finalPath, { force: true }),
        fs.rm(uploadDirectory, { recursive: true, force: true }),
      ]);
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, 'LOCAL_FILE_UPLOAD_FAILED', '无法读取所选文件。');
    }
  }

  private getSessionDirectory(sessionId: string): Promise<string> {
    let directory = this.sessionDirectories.get(sessionId);
    if (!directory) {
      directory = this.createSessionDirectory();
      this.sessionDirectories.set(sessionId, directory);
    }
    return directory;
  }

  private async createSessionDirectory(): Promise<string> {
    const runtimeRoot = await this.getRuntimeRoot();
    return fs.mkdtemp(path.join(runtimeRoot, 'session-'));
  }

  private getRuntimeRoot(): Promise<string> {
    this.runtimeRootPromise ??= (async () => {
      await fs.mkdir(this.options.rootDirectory, { recursive: true, mode: 0o700 });
      return fs.mkdtemp(path.join(this.options.rootDirectory, 'runtime-'));
    })();
    return this.runtimeRootPromise;
  }
}

export function createLocalWebFileRouter(
  manager: SessionManager,
  store: LocalWebFileStore,
) {
  return async function localWebFileRouter(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost');
    const match = url.pathname.match(/^\/api\/local-file\/open\/([^/]+)$/u);
    if (!match || req.method !== 'POST') {
      throw new HttpError(404, 'NOT_FOUND', 'Not found');
    }
    if (!isLoopbackWebOrigin(req.headers.origin)) {
      throw new HttpError(
        403,
        'REMOTE_LOCAL_FILE_FORBIDDEN',
        '远程 Web 访问不能打开本机文件，请在运行 Harbors 的设备上通过 localhost 访问，或使用桌面版。',
      );
    }
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/octet-stream')) {
      throw new HttpError(415, 'INVALID_LOCAL_FILE_CONTENT_TYPE', '本机文件请求格式无效。');
    }
    const sessionId = safeDecode(match[1]);
    if (!sessionId || !manager.get(sessionId)) {
      throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session not found');
    }
    const fileName = url.searchParams.get('name') ?? '';
    const staged = await store.stage(sessionId, fileName, req);
    res.setHeader('Cache-Control', 'no-store');
    sendJson(res, 201, { ...staged, access: 'readonly-copy' });
  };
}

export function isLoopbackWebOrigin(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const origin = new URL(value);
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return false;
    const hostname = origin.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
    const version = isIP(hostname);
    return (version === 4 && hostname.startsWith('127.')) || (version === 6 && hostname === '::1');
  } catch {
    return false;
  }
}

function assertContentLength(value: string | undefined, maxBytes: number): void {
  if (value === undefined) return;
  if (!/^\d+$/u.test(value)) {
    throw new HttpError(400, 'INVALID_CONTENT_LENGTH', '本机文件大小无效。');
  }
  const size = Number(value);
  if (!Number.isSafeInteger(size)) throw fileTooLarge(maxBytes);
  if (size > maxBytes) throw fileTooLarge(maxBytes);
}

function fileTooLarge(maxBytes: number): HttpError {
  return new HttpError(
    413,
    'LOCAL_FILE_TOO_LARGE',
    `所选文件不能超过 ${Math.floor(maxBytes / (1024 * 1024))} MiB。`,
    { maxBytes },
  );
}

function sanitizeFileName(value: string): string {
  const base = path.basename(value || 'selected-file')
    .replaceAll(/[\u0000-\u001f<>:"/\\|?*]/gu, '_')
    .trim();
  const safe = base === '' || base === '.' || base === '..' ? 'selected-file' : base;
  return safe.slice(-160);
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
