import assert from 'node:assert/strict';
import test from 'node:test';

import { filePathFromPreviewLink, validatePreviewLink, type PreviewLinkPayload } from './uri.js';

function payload(href: string, protocol: PreviewLinkPayload['protocol']): PreviewLinkPayload {
  return { href, originalHref: href, protocol };
}

test('decodes file URI paths and excludes query/hash from the local path', () => {
  const value = payload('file:///tmp/%E4%B8%AD%E6%96%87%20notes.md?raw=1#section', 'file');

  assert.equal(filePathFromPreviewLink(value), '/tmp/中文 notes.md');
  const result = validatePreviewLink(value);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.link.href, 'file:///tmp/%E4%B8%AD%E6%96%87%20notes.md?raw=1#section');
});

test('accepts absolute HTTP and HTTPS URIs', () => {
  for (const protocol of ['http', 'https'] as const) {
    const result = validatePreviewLink(payload(`${protocol}://example.test/a?x=1#part`, protocol));
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.link.protocol, protocol);
  }
});

test('rejects relative values, bare paths, and unknown schemes', () => {
  for (const [href, protocol] of [
    ['../README.md', 'file'],
    ['/tmp/README.md', 'file'],
    ['harbors://open/file', 'unsupported'],
  ] as const) {
    assert.equal(validatePreviewLink(payload(href, protocol)).ok, false);
    assert.equal(filePathFromPreviewLink(payload(href, protocol)), null);
  }
});

test('rejects protocol metadata that disagrees with the URI scheme', () => {
  assert.equal(validatePreviewLink(payload('https://example.test/file.txt', 'file')).ok, false);
  assert.equal(validatePreviewLink(payload('file:///tmp/file.txt', 'https')).ok, false);
});

test('rejects non-standard file URI forms', () => {
  assert.equal(validatePreviewLink(payload('file:/tmp/file.txt', 'file')).ok, false);
  assert.equal(validatePreviewLink(payload('file://server/tmp/file.txt', 'file')).ok, false);
});
