import { describe, expect, it } from 'vitest';

import { encodeKitId, normalizeArchivePath } from '../src/index.js';

describe('normalizeArchivePath', () => {
  it('preserves a normalized POSIX relative path', () => {
    expect(normalizeArchivePath('plugins/demo/main/dist/index.js')).toBe(
      'plugins/demo/main/dist/index.js',
    );
  });

  it.each([
    '',
    '/absolute/file.js',
    'plugins//file.js',
    './plugins/file.js',
    'plugins/../file.js',
    '../file.js',
    'plugins\\file.js',
    'plugins/file.js\0tail',
  ])('rejects unsafe archive path %j', (value) => {
    expect(() => normalizeArchivePath(value)).toThrow(/archive path/i);
  });
});

describe('encodeKitId', () => {
  it('encodes a Kit id as an unpadded URL-safe directory name', () => {
    const encoded = encodeKitId('@example/kit-demo');

    expect(encoded).toBe(Buffer.from('@example/kit-demo', 'utf8').toString('base64url'));
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it('rejects an empty Kit id', () => {
    expect(() => encodeKitId('')).toThrow(/Kit id/i);
  });
});
