import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

function resolvePluginAsset(pluginRoot: string, publicRoots: string[], requestRelativePath: string): string | null {
  for (const publicRoot of publicRoots) {
    const base = path.resolve(pluginRoot, publicRoot);
    const candidate = path.resolve(base, requestRelativePath);
    if (candidate.startsWith(base + path.sep)) return candidate;
  }
  return null;
}

test('markdown renderer entry maps through the public asset route', async () => {
  const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
  const packageJson = JSON.parse(await readFile(path.join(pluginRoot, 'package.json'), 'utf8')) as {
    name: string;
    'ce-editor': {
      assets: { public: string[] };
      contribute: { chat: { markdownRenderer: { entry: string } } };
    };
  };
  const entry = packageJson['ce-editor'].contribute.chat.markdownRenderer.entry;
  const requestRelativePath = entry.replace(/^\.\//u, '');
  const expectedUrl = `/api/assets/plugin/${encodeURIComponent(packageJson.name)}/${encodeURIComponent(requestRelativePath)}`;
  assert.equal(entry, './renderer.js');
  assert.equal(expectedUrl, '/api/assets/plugin/mermaid/renderer.js');

  const resolved = resolvePluginAsset(
    pluginRoot,
    packageJson['ce-editor'].assets.public,
    requestRelativePath,
  );
  assert.equal(resolved, path.join(pluginRoot, 'assets', 'renderer.js'));
  assert.equal((await stat(resolved!)).isFile(), true);

  const rendererSource = await readFile(resolved!, 'utf8');
  assert.match(rendererSource, /\/api\/assets\/plugin\/mermaid\/mermaid\.min\.js/u);
  assert.doesNotMatch(rendererSource, /\/api\/assets\/plugin\/mermaid\/assets\/mermaid\.min\.js/u);
});
