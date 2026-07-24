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
