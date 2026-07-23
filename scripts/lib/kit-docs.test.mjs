import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('root scripts expose the Kit artifact CLI', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url)));
  assert.equal(packageJson.scripts.kit, 'node packages/kit-cli/dist/cli.js');
  assert.equal(packageJson.scripts['kit:publish'], 'node scripts/kit-publish.mjs');
  assert.equal(packageJson.scripts['kits:validate'], 'npm run kit -- validate');
});

test('Kit artifact guide documents the complete marketplace and product-branch workflow', async () => {
  const guide = await readFile(new URL('../../docs/guides/kit-artifacts.md', import.meta.url), 'utf8');
  const prose = guide.replace(/\s+/gu, ' ');
  for (const command of [' validate ', ' pack ', ' inspect ']) {
    assert.match(guide, new RegExp(`npm run kit --${command}`));
  }
  for (const guarantee of [
    'If-None-Match',
    'KitReleaseResolver',
    'KitArtifactDownloader',
    'KitRegistryManager',
    'GitHubArtifactAttestationVerifier',
    'sigstore@3.1.0',
    'Kit Manager…',
    'pending',
    'bad',
    'audit.ndjson',
    'actions/attest@v4',
    'kit-publish-v1',
    'kit-registry',
    'GitHub Pages',
    'githubusercontent.com',
    'kit-stable',
    'kit/sqlite',
    'kit/mysql',
    'kit/notifications',
    'migrate-kit-product.mjs',
    'migrate-kit-registry.mjs',
    'start-kit-change.sh',
    'finish-kit-change.sh',
    'release-kit.sh',
  ]) assert.match(prose, new RegExp(guarantee, 'i'));
  assert.match(prose, /kit-workflow/i);
  assert.match(prose, /不推送|不会[^。]{0,20}推送/i);
  assert.doesNotMatch(
    prose,
    /marketplace UI.*尚未|Electron IPC.*尚未|真实 GitHub.*尚未|later phase|product-branch migration/i,
  );
});

test('development workflow separates Framework and Kit branch governance', async () => {
  const guide = await readFile(new URL('../../docs/guides/development-workflow.md', import.meta.url), 'utf8');
  const prose = guide.replace(/\s+/gu, ' ');
  for (const boundary of [
    'change-workflow',
    'kit-workflow',
    'feature/<type>/<slug>',
    'kit-change/<kit>/<type>/<slug>',
    'kit/<kit>',
    'kit-registry',
  ]) assert.match(prose, new RegExp(boundary.replaceAll('/', '\\/'), 'i'));
  assert.match(prose, /Framework.*main/i);
  assert.match(prose, /Stable.*明确确认/i);
});
