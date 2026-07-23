import path from 'node:path';

export function normalizeArchivePath(value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Archive path must be a non-empty string');
  }
  if (value.includes('\\') || value.includes('\0') || path.posix.isAbsolute(value)) {
    throw new Error(`Unsafe archive path: ${JSON.stringify(value)}`);
  }

  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe archive path: ${JSON.stringify(value)}`);
  }

  const normalized = path.posix.normalize(value);
  if (normalized !== value) {
    throw new Error(`Archive path is not normalized: ${JSON.stringify(value)}`);
  }
  return normalized;
}

export function encodeKitId(id: string): string {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('Kit id must be a non-empty string');
  }
  return Buffer.from(id, 'utf8').toString('base64url');
}
