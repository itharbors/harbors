import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { definition } from './index.ts';

test('reads local HTML as escaped code input instead of executable URL content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harbors-preview-html-'));
  const path = join(directory, 'unsafe.html');
  const content = '<script>globalThis.executed = true</script><h1>code</h1>';
  try {
    await writeFile(path, content);
    const href = pathToFileURL(path).href;
    const result = await definition.methods.readFile({ href, originalHref: href, protocol: 'file' });
    assert.equal(result.kind, 'file');
    assert.equal(result.language, 'html');
    assert.equal(result.content, content);
    assert.equal('snapshotHtml' in result, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
