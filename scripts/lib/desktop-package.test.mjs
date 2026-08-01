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
  {
    foreignPlatform = false,
    forbiddenArtifact = false,
    wrapperManifest: wrapperManifestOverride = {},
    nativeManifest: nativeManifestOverride = {},
    extraNativeFile = false,
    extraUnpackedNativeFile = false,
    omitWrapperMain = false,
    credentialModuleContent = 'export const credentialBackend = "os-keyring";\n',
    keyringTextContent = 'module.exports = {};\n',
  } = {},
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
export function migrateDatabase(database) {
  database.exec('CREATE TABLE credential_profiles (id TEXT)');
}
`);
  const wrapperManifest = {
    name: '@napi-rs/keyring',
    version: '1.3.0',
    main: 'index.js',
    files: ['index.d.ts', 'index.js', 'keytar.js', 'keytar.d.ts'],
    optionalDependencies: {
      '@napi-rs/keyring-darwin-arm64': '1.3.0',
      '@napi-rs/keyring-darwin-x64': '1.3.0',
      '@napi-rs/keyring-freebsd-x64': '1.3.0',
      '@napi-rs/keyring-linux-arm-gnueabihf': '1.3.0',
      '@napi-rs/keyring-linux-arm64-gnu': '1.3.0',
      '@napi-rs/keyring-linux-arm64-musl': '1.3.0',
      '@napi-rs/keyring-linux-riscv64-gnu': '1.3.0',
      '@napi-rs/keyring-linux-x64-gnu': '1.3.0',
      '@napi-rs/keyring-linux-x64-musl': '1.3.0',
      '@napi-rs/keyring-win32-arm64-msvc': '1.3.0',
      '@napi-rs/keyring-win32-ia32-msvc': '1.3.0',
      '@napi-rs/keyring-win32-x64-msvc': '1.3.0',
    },
    ...wrapperManifestOverride,
  };
  const nativeManifest = {
    name: '@napi-rs/keyring-darwin-arm64',
    version: '1.3.0',
    main: 'keyring.darwin-arm64.node',
    files: ['keyring.darwin-arm64.node'],
    os: ['darwin'],
    cpu: ['arm64'],
    ...nativeManifestOverride,
  };
  await write(source, 'node_modules/@napi-rs/keyring/package.json', JSON.stringify(wrapperManifest));
  if (!omitWrapperMain) await write(source, 'node_modules/@napi-rs/keyring/index.js', `
function isMuslFromChildProcess() {
  return require('child_process').execSync('ldd --version', { encoding: 'utf8' }).includes('musl');
}
module.exports = { Entry: class {}, isMuslFromChildProcess };
`);
  await write(source, 'node_modules/@napi-rs/keyring/index.d.ts', 'export declare class Entry {}\n');
  await write(source, 'node_modules/@napi-rs/keyring/keytar.js', keyringTextContent);
  await write(source, 'node_modules/@napi-rs/keyring/keytar.d.ts', 'export {};\n');
  await write(
    source,
    'node_modules/@napi-rs/keyring-darwin-arm64/package.json',
    JSON.stringify(nativeManifest),
  );
  await write(
    source,
    'node_modules/@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node',
    'fixture native binary',
  );
  if (extraNativeFile) {
    await write(
      source,
      'node_modules/@napi-rs/keyring-darwin-arm64/extra.node',
      'unexpected native binary',
    );
  }
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
  await write(source, 'dist/credentials.js', credentialModuleContent);
  await mkdir(resources, { recursive: true });
  await createPackageWithOptions(source, path.join(resources, 'app.asar'), {
    unpack: '**/*.node',
  });
  if (extraUnpackedNativeFile) {
    await write(
      path.join(resources, 'app.asar.unpacked'),
      'node_modules/@napi-rs/keyring-darwin-arm64/stray.node',
      'stray unpacked native binary',
    );
  }
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

for (const fixture of [
  {
    name: 'wrapper name',
    options: { wrapperManifest: { name: '@example/keyring' } },
  },
  {
    name: 'wrapper version',
    options: { wrapperManifest: { version: '9.9.9' } },
  },
  {
    name: 'wrapper main',
    options: { wrapperManifest: { main: 'keytar.js' } },
  },
  {
    name: 'missing wrapper main',
    options: { omitWrapperMain: true },
  },
  {
    name: 'wrapper native dependency relation',
    options: { wrapperManifest: { optionalDependencies: {} } },
  },
  {
    name: 'native name',
    options: { nativeManifest: { name: '@example/keyring-darwin-arm64' } },
  },
  {
    name: 'native version',
    options: { nativeManifest: { version: '9.9.9' } },
  },
  {
    name: 'native operating system',
    options: { nativeManifest: { os: ['linux'] } },
  },
  {
    name: 'native architecture',
    options: { nativeManifest: { cpu: ['x64'] } },
  },
  {
    name: 'native main',
    options: { nativeManifest: { main: 'extra.node' } },
  },
  {
    name: 'native files',
    options: { nativeManifest: { files: ['extra.node'] } },
  },
]) {
  test(`rejects a packaged keyring with an invalid ${fixture.name}`, async (t) => {
    const cwd = await createPackagedKeyringFixture(t, fixture.options);
    const runner = commandRunner();

    await assert.rejects(
      runDesktopPackage({ cwd, mode: 'dir', run: runner.run }),
      /invalid .* manifest|native dependency/iu,
    );
  });
}

for (const fixture of [
  { name: 'archive', options: { extraNativeFile: true } },
  { name: 'unpacked directory', options: { extraUnpackedNativeFile: true } },
]) {
  test(`rejects an extra keyring native file in the ${fixture.name}`, async (t) => {
    const cwd = await createPackagedKeyringFixture(t, fixture.options);

    await assert.rejects(
      runDesktopPackage({ cwd, mode: 'dir', run: commandRunner().run }),
      /native file closure/u,
    );
  });
}

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

for (const fixture of [
  { name: 'child process import', content: "import 'node:child_process';\n" },
  { name: 'exec call', content: "exec('credential-helper');\n" },
  { name: 'spawn call', content: "spawn('credential-helper');\n" },
  { name: 'Linux secret-tool helper', content: "const helper = 'secret-tool';\n" },
  { name: 'macOS security helper', content: "const helper = '/usr/bin/security add-generic-password';\n" },
  { name: 'Windows cmdkey helper', content: "const helper = 'cmdkey.exe';\n" },
  { name: 'basic text backend', content: "const backend = 'basic_text';\n" },
  { name: 'plaintext store', content: "const backend = 'plaintext store';\n" },
  { name: 'fixed key', content: "const strategy = 'fixed-key';\n" },
]) {
  test(`rejects ${fixture.name} content from an ordinary credential module path`, async (t) => {
    const cwd = await createPackagedKeyringFixture(t, {
      credentialModuleContent: fixture.content,
    });

    await assert.rejects(
      runDesktopPackage({ cwd, mode: 'dir', run: commandRunner().run }),
      /forbidden credential fallback content/u,
    );
  });
}

test('rejects forbidden fallback content from a packaged keyring text entry', async (t) => {
  const cwd = await createPackagedKeyringFixture(t, {
    keyringTextContent: "module.exports = 'secret-tool';\n",
  });

  await assert.rejects(
    runDesktopPackage({ cwd, mode: 'dir', run: commandRunner().run }),
    /forbidden credential fallback content/u,
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
