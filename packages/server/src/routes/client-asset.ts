import { createReadStream, realpathSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
});

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function requestPathname(url: string): string | null {
  const separator = url.search(/[?#]/u);
  const rawPathname = separator === -1 ? url : url.slice(0, separator);
  if (!rawPathname.startsWith('/')) return null;
  return safeDecode(rawPathname);
}

interface ExistingFile {
  path: string;
  size: number;
}

function resolveExistingFile(realRoot: string, relative: string): ExistingFile | null {
  if (
    relative.includes('\0')
    || path.isAbsolute(relative)
    || relative.split(/[\\/]/u).includes('..')
  ) return null;
  const rootPrefix = `${realRoot}${path.sep}`;
  const resolved = path.resolve(realRoot, relative);
  if (!resolved.startsWith(rootPrefix)) return null;
  try {
    const realCandidate = realpathSync(resolved);
    if (!realCandidate.startsWith(rootPrefix)) return null;
    const info = statSync(realCandidate);
    if (!info.isFile()) return null;
    return { path: realCandidate, size: info.size };
  } catch {
    return null;
  }
}

function contentType(filename: string): string {
  return CONTENT_TYPES[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

function sendNotFound(res: ServerResponse): true {
  res.statusCode = 404;
  res.end();
  return true;
}

export function createClientAssetRouter(root: string) {
  const realRoot = realpathSync(root);
  const indexPath = resolveExistingFile(realRoot, 'index.html');
  if (!indexPath) throw new Error('Client asset root must contain an index.html file');

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const pathname = requestPathname(req.url || '/');
    if (pathname === null) return sendNotFound(res);
    const assetPrefix = '/assets/';
    const isAsset = pathname.startsWith(assetPrefix);
    const assetRelative = isAsset ? pathname.slice(assetPrefix.length) : '';
    if (isAsset && path.isAbsolute(assetRelative)) return sendNotFound(res);
    const relative = isAsset ? path.join('assets', assetRelative) : 'index.html';
    const candidate = resolveExistingFile(realRoot, relative);
    if (!candidate || (isAsset && candidate.path === indexPath.path)) return sendNotFound(res);

    res.statusCode = 200;
    res.setHeader('Content-Type', contentType(candidate.path));
    res.setHeader('Content-Length', candidate.size);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'HEAD') res.end();
    else await pipeline(createReadStream(candidate.path), res);
    return true;
  };
}
