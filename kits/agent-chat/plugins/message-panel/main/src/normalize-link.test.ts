import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeLink } from './normalize-link.ts';

const project = '/tmp/Harbors 项目';
const projectHref = pathToFileURL(`${project}${path.sep}`).href;

test('resolves relative paths as file URLs while preserving URI encoding and query/fragment', () => {
  assert.equal(normalizeLink('docs/a%20b.md?raw=1#L2', project).href, `${projectHref}docs/a%20b.md?raw=1#L2`);
  assert.equal(normalizeLink('../README.md', project).href, 'file:///tmp/README.md');
  assert.equal(normalizeLink('中文 空格.md', project).href, `${projectHref}%E4%B8%AD%E6%96%87%20%E7%A9%BA%E6%A0%BC.md`);
});

test('resolves absolute paths as file URLs while preserving query/fragment', () => {
  assert.equal(normalizeLink('/tmp/中文 文件.md?raw=1#L2').href, 'file:///tmp/%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6.md?raw=1#L2');
});

test('normalizes file URLs and canonicalizes http/https URLs', () => {
  assert.equal(normalizeLink('file:///tmp/中文 文件.md?raw=1#L2').href, 'file:///tmp/%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6.md?raw=1#L2');
  assert.deepEqual(normalizeLink('file://server/path'), { href: 'file://server/path', originalHref: 'file://server/path', protocol: 'unsupported' });
  assert.deepEqual(normalizeLink('https://例子.test/a b?q=中文#片段'), {
    href: 'https://xn--fsqu00a.test/a%20b?q=%E4%B8%AD%E6%96%87#%E7%89%87%E6%AE%B5',
    originalHref: 'https://例子.test/a b?q=中文#片段',
    protocol: 'https',
  });
  assert.equal(normalizeLink('http://example.com').protocol, 'http');
});

test('rejects unsupported schemes, scheme-relative URLs, and references without a project', () => {
  for (const href of ['mailto:test@example.com', 'harbors://plugin/open', '//host/path', '#section', '?line=2', 'README.md']) {
    assert.deepEqual(normalizeLink(href), { href, originalHref: href, protocol: 'unsupported' });
  }
});
