import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runDesktopPackage } from './desktop-package-build.mjs';

function commandRunner({ fail = {} } = {}) {
  const calls = [];
  return {
    calls,
    run: async (step) => {
      calls.push(step);
      if (fail[step.name]) throw fail[step.name];
      return step.name;
    },
  };
}

test('rebuilds the packaged native addon before builder and restores the Node ABI afterwards', async () => {
  const runner = commandRunner();

  await runDesktopPackage({
    cwd: '/workspace/harbors',
    mode: 'dir',
    run: runner.run,
    electronRebuildCli: '/workspace/harbors/node_modules/@electron/rebuild/bin/cli.js',
  });

  assert.deepEqual(runner.calls.map((step) => step.name), [
    'prepare',
    'electron-rebuild',
    'electron-builder',
    'restore-node-addon',
  ]);
  assert.deepEqual(runner.calls[1].args, [
    '/workspace/harbors/node_modules/@electron/rebuild/bin/cli.js',
    '-f',
    '-w',
    'better-sqlite3',
    '--version',
    '31.7.7',
    '--arch',
    'arm64',
  ]);
});

test('restores the Node ABI when electron-builder fails and preserves its failure', async () => {
  const builderFailure = new Error('builder failed');
  const runner = commandRunner({ fail: { 'electron-builder': builderFailure } });

  await assert.rejects(
    runDesktopPackage({ cwd: '/workspace/harbors', mode: 'dir', run: runner.run }),
    (error) => error === builderFailure,
  );
  assert.deepEqual(runner.calls.map((step) => step.name), [
    'prepare',
    'electron-rebuild',
    'electron-builder',
    'restore-node-addon',
  ]);
});

test('reports both packaging and Node ABI restoration failures', async () => {
  const builderFailure = new Error('builder failed');
  const restoreFailure = new Error('restore failed');
  const runner = commandRunner({
    fail: { 'electron-builder': builderFailure, 'restore-node-addon': restoreFailure },
  });

  await assert.rejects(
    runDesktopPackage({ cwd: '/workspace/harbors', mode: 'dir', run: runner.run }),
    (error) => error instanceof AggregateError
      && error.errors[0] === builderFailure
      && error.errors[1] === restoreFailure,
  );
});

test('surfaces a Node ABI restoration failure after a successful package build', async () => {
  const restoreFailure = new Error('restore failed');
  const runner = commandRunner({ fail: { 'restore-node-addon': restoreFailure } });

  await assert.rejects(
    runDesktopPackage({ cwd: '/workspace/harbors', mode: 'dist', run: runner.run }),
    (error) => error === restoreFailure,
  );
  assert.equal(runner.calls[2].name, 'electron-builder');
  assert.deepEqual(runner.calls[2].args.slice(-2), ['--publish', 'never']);
});

test('desktop package owns version, updater, and native runtime dependencies', async () => {
  const pkg = JSON.parse(await readFile(new URL('../../packages/desktop/package.json', import.meta.url)));
  const rootPackage = JSON.parse(await readFile(new URL('../../package.json', import.meta.url)));
  const desktopBuildSource = await readFile(new URL('./desktop-build.mjs', import.meta.url), 'utf8');
  assert.equal(pkg.name, '@itharbors/desktop');
  assert.equal(pkg.version, '0.1.0-preview.1');
  assert.equal(pkg.main, 'dist/main.mjs');
  assert.equal(pkg.dependencies['electron-updater'], '6.8.9');
  assert.equal(pkg.dependencies['better-sqlite3'], '11.10.0');
  assert.equal(rootPackage.devDependencies['@electron/rebuild'], '4.2.0');
  assert.equal(rootPackage.scripts['desktop:dir'], 'node scripts/desktop-package.mjs dir');
  assert.equal(rootPackage.scripts['desktop:dist'], 'node scripts/desktop-package.mjs dist');
  for (const [name, version] of [
    ['sigstore', '3.1.0'],
    ['snappyjs', '0.7.0'],
    ['yauzl', '^3.4.0'],
  ]) {
    assert.equal(pkg.dependencies[name], version);
    assert.match(desktopBuildSource, new RegExp(`external: \\[[^\\]]*'${name}'`, 'u'));
  }
});

test('generated desktop bundle leaves registry CommonJS dependencies to the runtime loader', async () => {
  const bundle = await readFile(new URL('../../packages/desktop/dist/main.mjs', import.meta.url), 'utf8');

  for (const name of ['sigstore', 'snappyjs', 'yauzl']) {
    assert.match(bundle, new RegExp(`from ['"]${name}['"]`, 'u'));
  }
  assert.doesNotMatch(bundle, /node_modules\/@sigstore\//u);
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
  assert.equal(config.artifactName, '${productName}-${version}-${arch}-mac.${ext}');
  assert.equal(config.dmg.artifactName, '${productName}-${version}-${arch}.${ext}');
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
    assert.match(text, /v<semver>/u);
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
