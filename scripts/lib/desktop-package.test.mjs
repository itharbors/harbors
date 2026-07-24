import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

test('desktop package owns version, updater, and native runtime dependencies', async () => {
  const pkg = JSON.parse(await readFile(new URL('../../packages/desktop/package.json', import.meta.url)));
  assert.equal(pkg.name, '@itharbors/desktop');
  assert.equal(pkg.version, '0.1.0-preview.1');
  assert.equal(pkg.main, 'dist/main.mjs');
  assert.equal(pkg.dependencies['electron-updater'], '6.8.9');
  assert.equal(pkg.dependencies['better-sqlite3'], '11.10.0');
});

test('builder ships only the staged runtime and unpacks native modules', async () => {
  const config = (await import('../../electron-builder.config.mjs')).default;
  const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
  const entitlementsPath = path.join(repositoryRoot, 'build', 'entitlements.mac.plist');

  assert.equal(config.appId, 'com.itharbors.desktop');
  assert.deepEqual(config.directories, {
    app: 'packages/desktop',
    output: 'dist/desktop-release',
  });
  assert.deepEqual(config.mac.target, [{ target: 'dmg', arch: ['arm64'] }, { target: 'zip', arch: ['arm64'] }]);
  assert.match(JSON.stringify(config.extraResources), /dist\/desktop-runtime/);
  assert.match(JSON.stringify(config.asarUnpack), /\.node/);
  assert.equal(path.resolve(repositoryRoot, config.mac.entitlements), entitlementsPath);
  assert.equal(path.resolve(repositoryRoot, config.mac.entitlementsInherit), entitlementsPath);
  await access(entitlementsPath);
});

test('desktop release documentation preserves operational safety boundaries', async () => {
  const rootUrl = new URL('../../', import.meta.url);
  const releaseGuideUrl = new URL('docs/guides/app-releases.md', rootUrl);
  const documentUrls = [
    releaseGuideUrl,
    new URL('readme.md', rootUrl),
    new URL('docs/README.md', rootUrl),
    new URL('docs/architecture/system-overview.md', rootUrl),
    new URL('docs/architecture/runtime-flows.md', rootUrl),
    new URL('docs/guides/development-workflow.md', rootUrl),
  ];
  const documents = await Promise.all(documentUrls.map((url) => readFile(url, 'utf8')));

  for (const text of documents) {
    assert.match(text, /app\/v<semver>/u);
    assert.match(text, /Developer ID Application/u);
    assert.match(text, /app-publish-v1/u);
  }

  const releaseGuide = documents[0];
  assert.match(releaseGuide, /MAC_CSC_LINK/u);
  assert.match(releaseGuide, /App Store Connect Team API Key/u);
  assert.match(releaseGuide, /gh attestation verify/u);
  assert.match(releaseGuide, /Developer ID Installer.*not required|not required.*Developer ID Installer/u);
  assert.match(releaseGuide, /implementation.*merge.*not.*exact release confirmation|exact release confirmation.*implementation.*merge/u);
  assert.match(releaseGuide, /app-preview/u);
  assert.match(releaseGuide, /app-stable/u);
  assert.match(releaseGuide, /higher version|higher SemVer/u);
  assert.match(releaseGuide, /unsigned.*structural|structural.*unsigned/u);
});
