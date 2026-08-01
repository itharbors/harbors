import assert from 'node:assert/strict';
import test from 'node:test';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { createPackageWithOptions } from '@electron/asar';
import {
  DESKTOP_ELECTRON_VERSION,
  createDesktopPackageSteps,
  runDesktopPackage,
} from './desktop-package-build.mjs';

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

async function write(root, relative, contents = relative) {
  const filename = path.join(root, relative);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, contents);
}

async function createPackagedKeyringFixture(
  t,
  { foreignPlatform = false, forbiddenArtifact = false } = {},
) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'harbors-desktop-package-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const source = path.join(cwd, 'fixture-app');
  const resources = path.join(
    cwd,
    'dist',
    'desktop-release',
    'mac-arm64',
    'ITHARBORS.app',
    'Contents',
    'Resources',
  );
  await write(source, 'dist/framework.mjs', `
export async function loadKeyring() {
  return import('@napi-rs/keyring');
}
`);
  await write(source, 'node_modules/@napi-rs/keyring/package.json', JSON.stringify({
    name: '@napi-rs/keyring',
    version: '1.3.0',
    main: 'index.js',
  }));
  await write(source, 'node_modules/@napi-rs/keyring/index.js', 'module.exports = { Entry: class {} };\n');
  await write(source, 'node_modules/@napi-rs/keyring-darwin-arm64/package.json', JSON.stringify({
    name: '@napi-rs/keyring-darwin-arm64',
    version: '1.3.0',
    os: ['darwin'],
    cpu: ['arm64'],
  }));
  await write(
    source,
    'node_modules/@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node',
    'fixture native binary',
  );
  if (foreignPlatform) {
    await write(source, 'node_modules/@napi-rs/keyring-linux-x64-gnu/package.json', JSON.stringify({
      name: '@napi-rs/keyring-linux-x64-gnu',
      version: '1.3.0',
      os: ['linux'],
      cpu: ['x64'],
    }));
    await write(
      source,
      'node_modules/@napi-rs/keyring-linux-x64-gnu/keyring.linux-x64-gnu.node',
      'foreign native binary',
    );
  }
  if (forbiddenArtifact) {
    await write(source, 'dist/plaintext-store.json', '{"password":"fixture"}');
  }
  await mkdir(resources, { recursive: true });
  await createPackageWithOptions(source, path.join(resources, 'app.asar'), {
    unpack: '**/*.node',
  });
  return cwd;
}

test('rebuilds the packaged native addon before builder and restores the Node ABI afterwards', async () => {
  const runner = commandRunner();

  await runDesktopPackage({
    cwd: '/workspace/harbors',
    mode: 'dir',
    run: runner.run,
    verify: async () => undefined,
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
    '43.2.0',
    '--arch',
    'arm64',
  ]);
});

test('accepts a fixture package with only the externalized unpacked Darwin ARM64 keyring', async (t) => {
  const cwd = await createPackagedKeyringFixture(t);
  const runner = commandRunner();

  const evidence = await runDesktopPackage({ cwd, mode: 'dir', run: runner.run });

  assert.deepEqual(evidence, {
    external: '@napi-rs/keyring',
    nativePackage: '@napi-rs/keyring-darwin-arm64',
    nativeFile: 'node_modules/@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node',
  });
});

test('rejects a fixture package containing a foreign native keyring platform', async (t) => {
  const cwd = await createPackagedKeyringFixture(t, { foreignPlatform: true });
  const runner = commandRunner();

  await assert.rejects(
    runDesktopPackage({ cwd, mode: 'dir', run: runner.run }),
    /unexpected platform dependency closure/u,
  );
  assert.equal(runner.calls.at(-1).name, 'restore-node-addon');
});

test('rejects a fixture package containing a plaintext credential helper artifact', async (t) => {
  const cwd = await createPackagedKeyringFixture(t, { forbiddenArtifact: true });
  const runner = commandRunner();

  await assert.rejects(
    runDesktopPackage({ cwd, mode: 'dir', run: runner.run }),
    /forbidden credential helper artifact/u,
  );
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
    runDesktopPackage({
      cwd: '/workspace/harbors',
      mode: 'dist',
      run: runner.run,
      verify: async () => undefined,
    }),
    (error) => error === restoreFailure,
  );
  assert.equal(runner.calls[2].name, 'electron-builder');
  assert.deepEqual(runner.calls[2].args.slice(-2), ['--publish', 'never']);
});

test('unsigned packaging uses a dedicated non-publishing builder config', () => {
  const steps = createDesktopPackageSteps({
    cwd: '/workspace/harbors',
    mode: 'unsigned',
    electronBuilderCli: '/workspace/harbors/node_modules/electron-builder/cli.js',
  });

  assert.deepEqual(steps.map((step) => step.name), [
    'prepare',
    'electron-rebuild',
    'electron-builder',
    'restore-node-addon',
  ]);
  assert.deepEqual(steps[2].args, [
    '/workspace/harbors/node_modules/electron-builder/cli.js',
    '--config',
    'electron-builder.unsigned.config.mjs',
    '--mac',
    '--arm64',
    '--publish',
    'never',
  ]);
});

test('unsigned config preserves packaging inputs while disabling signing and notarization', async () => {
  const signed = (await import('../../electron-builder.config.mjs')).default;
  const unsigned = (await import('../../electron-builder.unsigned.config.mjs')).default;

  assert.equal(signed.mac.notarize, true);
  assert.equal(unsigned.mac.identity, null);
  assert.equal(unsigned.mac.notarize, false);
  assert.equal(unsigned.appId, signed.appId);
  assert.equal(unsigned.electronVersion, signed.electronVersion);
  assert.deepEqual(unsigned.directories, signed.directories);
  assert.deepEqual(unsigned.files, signed.files);
  assert.deepEqual(unsigned.extraResources, signed.extraResources);
  assert.deepEqual(unsigned.asarUnpack, signed.asarUnpack);
  assert.deepEqual(unsigned.mac.target, signed.mac.target);
});

test('desktop package owns version, updater, and native runtime dependencies', async () => {
  const pkg = JSON.parse(await readFile(new URL('../../packages/desktop/package.json', import.meta.url)));
  const rootPackage = JSON.parse(await readFile(new URL('../../package.json', import.meta.url)));
  const rootLock = JSON.parse(await readFile(new URL('../../package-lock.json', import.meta.url)));
  const builderConfig = (await import('../../electron-builder.config.mjs')).default;
  const desktopBuildSource = await readFile(new URL('./desktop-build.mjs', import.meta.url), 'utf8');
  assert.equal(pkg.name, '@itharbors/desktop');
  assert.equal(pkg.version, '0.1.0-preview.1');
  assert.equal(pkg.main, 'dist/main.mjs');
  assert.equal(pkg.dependencies['electron-updater'], '6.8.9');
  assert.equal(pkg.dependencies['better-sqlite3'], '12.10.1');
  assert.equal(pkg.dependencies['@napi-rs/keyring'], '1.3.0');
  assert.equal(rootLock.packages['packages/desktop'].dependencies['@napi-rs/keyring'], '1.3.0');
  assert.equal(rootLock.packages['node_modules/@napi-rs/keyring'].version, '1.3.0');
  assert.equal(rootLock.packages['node_modules/@napi-rs/keyring-darwin-arm64'].version, '1.3.0');
  assert.equal(rootPackage.engines.node, '>=22.12.0');
  assert.equal(rootPackage.devDependencies['@electron/rebuild'], '4.2.0');
  assert.equal(rootPackage.devDependencies.electron, DESKTOP_ELECTRON_VERSION);
  assert.equal(rootLock.packages[''].devDependencies.electron, DESKTOP_ELECTRON_VERSION);
  assert.equal(rootLock.packages['node_modules/electron'].version, DESKTOP_ELECTRON_VERSION);
  assert.equal(builderConfig.electronVersion, DESKTOP_ELECTRON_VERSION);
  assert.equal(rootPackage.scripts['desktop:dir'], 'node scripts/desktop-package.mjs dir');
  assert.equal(rootPackage.scripts['desktop:dist'], 'node scripts/desktop-package.mjs dist');
  assert.equal(rootPackage.scripts['desktop:unsigned'], 'node scripts/desktop-package.mjs unsigned');
  for (const [name, version] of [
    ['sigstore', '3.1.0'],
    ['snappyjs', '0.7.0'],
    ['yauzl', '^3.4.0'],
  ]) {
    assert.equal(pkg.dependencies[name], version);
    assert.match(desktopBuildSource, new RegExp(`external: \\[[^\\]]*'${name}'`, 'u'));
  }
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
  assert.ok(config.asarUnpack.includes('node_modules/@napi-rs/**/*.node'));
  assert.ok(config.asarUnpack.includes('node_modules/better-sqlite3/**/*.node'));
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
  assert.match(documents[1], /Node\.js 22\.12/u);
  assert.match(documents[1], /Electron-43/u);
  assert.match(documents[5], /Node\.js 22\.12/u);

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
  assert.match(releaseGuide, /Build Unsigned App/u);
  assert.match(releaseGuide, /workflow_dispatch/u);
  assert.match(releaseGuide, /ITHARBORS-<version>-unsigned-arm64\.dmg/u);
  assert.match(releaseGuide, /UNSIGNED-BUILD\.txt/u);
  assert.match(releaseGuide, /7 days|7 天/u);
  assert.match(releaseGuide, /unsigned[\s\S]*not.*Release|未签名[\s\S]*不是.*Release/u);
  assert.match(releaseGuide, /unsigned[\s\S]*not.*automatic update|未签名[\s\S]*不.*自动更新/u);
});
