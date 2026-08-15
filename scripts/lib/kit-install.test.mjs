import assert from 'node:assert/strict';
import {
  access,
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { ensureKitInstall } from './kit-install.mjs';
import { discoverRepositoryKits } from './repository-kits.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

async function createKitFixture(root, slug, version = '1.0.0') {
  await mkdir(path.join(root, 'packages', 'kit-cli', 'dist'), { recursive: true });
  await mkdir(path.join(root, 'plugins'), { recursive: true });
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await mkdir(path.join(root, 'node_modules'), { recursive: true });
  await writeFile(path.join(root, 'packages', 'kit-cli', 'package.json'), '{"name":"@example/kit-cli","version":"1.2.3"}\n');
  await writeFile(path.join(root, 'packages', 'kit-cli', 'dist', 'cli.js'), 'export {};\n');
  await writeFile(path.join(root, 'package.json'), '{"name":"fixture","private":true}\n');
  const directory = path.join(root, 'kits', slug);
  await mkdir(directory, { recursive: true });
  const packageJson = {
    name: `@example/kit-${slug}`,
    version,
    private: true,
  };
  const lock = {
    lockfileVersion: '9.0',
    importers: {
      '.': {},
    },
    packages: {},
  };
  await writeFile(path.join(directory, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeFile(path.join(directory, 'pnpm-workspace.yaml'), "packages: []\n");
  await writeFile(path.join(directory, 'pnpm-lock.yaml'), `${stringifyYaml(lock)}\n`);
  await writeFile(path.join(directory, 'source.txt'), `${slug}\n`);
  const pnpmExecutable = await createPnpmFixture(root);
  return { slug, id: packageJson.name, version, directory, pnpmExecutable };
}

async function readKitMetadata(descriptor) {
  return {
    packageFile: path.join(descriptor.directory, 'package.json'),
    lockFile: path.join(descriptor.directory, 'pnpm-lock.yaml'),
    packageJson: JSON.parse(await readFile(path.join(descriptor.directory, 'package.json'), 'utf8')),
    lock: parseYaml(await readFile(path.join(descriptor.directory, 'pnpm-lock.yaml'), 'utf8')),
  };
}

async function writeKitMetadata(metadata) {
  await writeFile(metadata.packageFile, `${JSON.stringify(metadata.packageJson, null, 2)}\n`);
  await writeFile(metadata.lockFile, `${stringifyYaml(metadata.lock)}\n`);
}

function toImporterDependencies(dependencies) {
  return Object.fromEntries(
    Object.entries(dependencies ?? {}).map(([name, specifier]) => [name, { specifier, version: specifier }]),
  );
}

async function createPnpmFixture(root, installBody = '') {
  const executable = path.join(root, `fake-pnpm-${Math.random().toString(16).slice(2)}.mjs`);
  await writeFile(executable, `#!/usr/bin/env node
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
const firstArg = process.argv[2];
if (firstArg === '--version') {
  console.log('9.12.0-fixture');
} else {
  const dirIndex = process.argv.indexOf('--dir');
  const installRoot = process.argv[dirIndex + 1];
  const command = process.argv[dirIndex + 2];
  if (command === 'install') {
    await mkdir(path.join(installRoot, 'node_modules'), { recursive: true });
    try {
      const pkg = JSON.parse(await readFile(path.join(installRoot, 'package.json'), 'utf8'));
      const workspaceYaml = await readFile(path.join(installRoot, 'pnpm-workspace.yaml'), 'utf8');
      const lines = workspaceYaml.split('\\n');
      let inPackages = false;
      const globs = [];
      for (const line of lines) {
        if (/^packages:\\s*$/.test(line)) { inPackages = true; continue; }
        if (inPackages) {
          const m = /^\\s*-\\s*['"]?([^'"]+)['"]?\\s*$/.exec(line);
          if (m) globs.push(m[1]);
          else if (line.trim() && !line.startsWith(' ') && !line.startsWith('\\t')) break;
        }
      }
      const nameToDir = {};
      for (const glob of globs) {
        const base = glob.replace(/\\/\\*$/, '');
        let entries = [];
        try { entries = await readdir(path.join(installRoot, base), { withFileTypes: true }); } catch {}
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const dir = path.join(base, entry.name);
          try {
            const wpkg = JSON.parse(await readFile(path.join(installRoot, dir, 'package.json'), 'utf8'));
            nameToDir[wpkg.name] = dir;
          } catch {}
        }
      }
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
          if (typeof spec === 'string' && spec.startsWith('workspace:')) {
            const target = nameToDir[name];
            if (target) {
              const linkPath = path.join(installRoot, 'node_modules', ...name.split('/'));
              await mkdir(path.dirname(linkPath), { recursive: true });
              await symlink(path.relative(path.dirname(linkPath), path.join(installRoot, target)), linkPath);
            }
          }
        }
      }
    } catch {}
    ${installBody}
  }
}
`);
  await chmod(executable, 0o755);
  return executable;
}

async function createRecordingPnpmFixture(root) {
  const executable = path.join(root, `recording-pnpm-${Math.random().toString(16).slice(2)}.mjs`);
  const logFile = path.join(root, `recording-pnpm-${Math.random().toString(16).slice(2)}.ndjson`);
  await writeFile(executable, `#!/usr/bin/env node
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
const firstArg = process.argv[2];
if (firstArg === '--version') {
  console.log('9.12.0-fixture');
} else {
  const dirIndex = process.argv.indexOf('--dir');
  const installRoot = process.argv[dirIndex + 1];
  const command = process.argv[dirIndex + 2];
  await appendFile(${JSON.stringify(logFile)}, JSON.stringify({ command, installRoot }) + '\\n');
  if (command === 'install') await mkdir(path.join(installRoot, 'node_modules'), { recursive: true });
}
`);
  await chmod(executable, 0o755);
  return { executable, logFile };
}

async function createEnvironmentSensitivePnpmFixture(root) {
  const executable = path.join(root, `environment-pnpm-${Math.random().toString(16).slice(2)}.mjs`);
  const logFile = path.join(root, `environment-pnpm-${Math.random().toString(16).slice(2)}.ndjson`);
  await writeFile(executable, `#!/usr/bin/env node
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const firstArg = process.argv[2];
if (firstArg === '--version') {
  console.log('9.12.0-fixture');
} else {
  const dirIndex = process.argv.indexOf('--dir');
  const installRoot = process.argv[dirIndex + 1];
  const command = process.argv[dirIndex + 2];
  const args = process.argv.slice(dirIndex + 3);
  const selection = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(?:node_env|npm_config_omit|npm_config_include)$/iu.test(key)));
  const tokens = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(?:node_auth_token|npm_token|github_token|gh_token)$/iu.test(key)));
  await appendFile(${JSON.stringify(logFile)}, JSON.stringify({ command, args, selection, tokens }) + '\\n');
  if (command === 'install') {
    await mkdir(path.join(installRoot, 'node_modules'), { recursive: true });
    if (args.includes('--frozen-lockfile') && Object.keys(selection).length === 0) {
      await writeFile(path.join(installRoot, 'node_modules', 'dev-tool'), 'installed');
    }
  }
}
`);
  await chmod(executable, 0o755);
  return { executable, logFile };
}

test('every repository Kit owns a lockfile and the root lock owns no Kit package', async () => {
  const descriptors = await discoverRepositoryKits({ repositoryRoot });
  const rootPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const rootLock = parseYaml(await readFile(path.join(repositoryRoot, 'pnpm-lock.yaml'), 'utf8'));
  const rootWorkspace = parseYaml(await readFile(path.join(repositoryRoot, 'pnpm-workspace.yaml'), 'utf8'));

  assert.deepEqual(rootWorkspace.packages, ['packages/*', 'plugins/*']);
  for (const descriptor of descriptors) {
    const lock = parseYaml(await readFile(path.join(descriptor.directory, 'pnpm-lock.yaml'), 'utf8'));
    assert.ok(lock.importers?.['.'], descriptor.slug);
  }
  assert.deepEqual(
    Object.keys(rootLock.importers ?? {}).filter((key) => key === 'kits' || key.startsWith('kits/')),
    [],
  );
});

test('reuses only a complete install with the same lock and runtime cache key', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-install-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const descriptor = await createKitFixture(root, 'alpha');
  const cacheRoot = path.join(root, 'cache');

  const first = await ensureKitInstall({ descriptor, cacheRoot, pnpmExecutable: descriptor.pnpmExecutable });
  await writeFile(path.join(descriptor.directory, 'source.txt'), 'current source\n');
  const second = await ensureKitInstall({ descriptor, cacheRoot, pnpmExecutable: descriptor.pnpmExecutable });

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(first.dependencyRoot, second.dependencyRoot);
  assert.notEqual(first.installRoot, second.installRoot);
  assert.equal(await readFile(path.join(second.installRoot, 'source.txt'), 'utf8'), 'current source\n');
});

test('dependency templates contain only node_modules projections and completion metadata', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-install-projection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const descriptor = await createKitFixture(root, 'alpha');
  const result = await ensureKitInstall({ descriptor, cacheRoot: path.join(root, 'cache'), pnpmExecutable: descriptor.pnpmExecutable });
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const relative = path.relative(result.dependencyRoot, entryPath);
      if (entry.isDirectory()) await visit(entryPath);
      else files.push(relative);
    }
  }
  await visit(result.dependencyRoot);

  assert.ok(files.some((file) => file === '.harbors-kit-install.json'));
  assert.ok(files.every((file) => (
    file === '.harbors-kit-install.json'
    || file.split(path.sep).includes('node_modules')
  )), files.join('\n'));
  for (const forbidden of ['source.txt', 'package.json', 'pnpm-lock.yaml', 'dist']) {
    assert.equal(files.some((file) => file.split(path.sep).includes(forbidden)), false, forbidden);
  }
});

test('a changed lock hash misses the cache', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-install-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const descriptor = await createKitFixture(root, 'alpha');
  const cacheRoot = path.join(root, 'cache');
  const first = await ensureKitInstall({ descriptor, cacheRoot, pnpmExecutable: descriptor.pnpmExecutable });
  const lockFile = path.join(descriptor.directory, 'pnpm-lock.yaml');
  const lock = parseYaml(await readFile(lockFile, 'utf8'));
  lock.importers['.'].cacheBuster = 'changed';
  await writeFile(lockFile, `${stringifyYaml(lock)}\n`);

  const second = await ensureKitInstall({ descriptor, cacheRoot, pnpmExecutable: descriptor.pnpmExecutable });

  assert.equal(second.reused, false);
  assert.notEqual(second.cacheKey, first.cacheKey);
  assert.notEqual(second.dependencyRoot, first.dependencyRoot);
});

test('a partial cache directory is replaced instead of reused', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-install-partial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const descriptor = await createKitFixture(root, 'alpha');
  const cacheRoot = path.join(root, 'cache');
  const first = await ensureKitInstall({ descriptor, cacheRoot, pnpmExecutable: descriptor.pnpmExecutable });
  await rm(first.dependencyRoot, { recursive: true, force: true });
  await mkdir(first.dependencyRoot, { recursive: true });
  await writeFile(path.join(first.dependencyRoot, 'partial.txt'), 'incomplete\n');

  const repaired = await ensureKitInstall({ descriptor, cacheRoot, pnpmExecutable: descriptor.pnpmExecutable });

  assert.equal(repaired.reused, false);
  await assert.rejects(readFile(path.join(repaired.dependencyRoot, 'partial.txt')));
  assert.equal(await readFile(path.join(repaired.installRoot, 'source.txt'), 'utf8'), 'alpha\n');
});

test('a completed template with deleted or tampered projection content is rebuilt under its key', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-install-corrupt-projection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const descriptor = await createKitFixture(root, 'alpha');
  const cacheRoot = path.join(root, 'cache');

  const first = await ensureKitInstall({ descriptor, cacheRoot, pnpmExecutable: descriptor.pnpmExecutable });
  await rm(path.join(first.dependencyRoot, 'node_modules'), { recursive: true, force: true });
  const repairedMissing = await ensureKitInstall({ descriptor, cacheRoot, pnpmExecutable: descriptor.pnpmExecutable });
  assert.equal(repairedMissing.reused, false);
  assert.equal((await lstat(path.join(repairedMissing.dependencyRoot, 'node_modules'))).isDirectory(), true);

  await writeFile(path.join(repairedMissing.dependencyRoot, 'node_modules', 'tampered.txt'), 'tampered\n');
  const repairedTamper = await ensureKitInstall({ descriptor, cacheRoot, pnpmExecutable: descriptor.pnpmExecutable });
  assert.equal(repairedTamper.reused, false);
  await assert.rejects(access(path.join(repairedTamper.dependencyRoot, 'node_modules', 'tampered.txt')));
});

test('a projection digest cannot collide by moving an entry header into file content', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-install-framed-digest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const descriptor = await createKitFixture(root, 'alpha');
  const pnpmExecutable = await createPnpmFixture(root, `
    await writeFile(path.join(installRoot, 'node_modules', 'a'), '');
    await writeFile(path.join(installRoot, 'node_modules', 'b'), 'Y');
  `);
  const cacheRoot = path.join(root, 'cache');
  const first = await ensureKitInstall({ descriptor, cacheRoot, pnpmExecutable });

  await rm(path.join(first.dependencyRoot, 'node_modules', 'b'));
  await writeFile(
    path.join(first.dependencyRoot, 'node_modules', 'a'),
    'f:node_modules/b\0Y',
  );

  const repaired = await ensureKitInstall({ descriptor, cacheRoot, pnpmExecutable });

  assert.equal(repaired.reused, false);
  assert.equal(await readFile(path.join(repaired.dependencyRoot, 'node_modules', 'a'), 'utf8'), '');
  assert.equal(await readFile(path.join(repaired.dependencyRoot, 'node_modules', 'b'), 'utf8'), 'Y');
});

test('a completed projection with a changed executable mode is rebuilt', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-install-mode-integrity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const descriptor = await createKitFixture(root, 'alpha');
  const pnpmExecutable = await createPnpmFixture(root, `
    await writeFile(path.join(installRoot, 'node_modules', 'tool'), '#!/bin/sh\\n', { mode: 0o755 });
  `);
  const cacheRoot = path.join(root, 'cache');
  const first = await ensureKitInstall({ descriptor, cacheRoot, pnpmExecutable });
  const cachedTool = path.join(first.dependencyRoot, 'node_modules', 'tool');
  await chmod(cachedTool, 0o644);

  const repaired = await ensureKitInstall({ descriptor, cacheRoot, pnpmExecutable });

  assert.equal(repaired.reused, false);
  assert.equal((await lstat(path.join(repaired.dependencyRoot, 'node_modules', 'tool'))).mode & 0o777, 0o755);
  assert.equal((await lstat(path.join(repaired.installRoot, 'node_modules', 'tool'))).mode & 0o777, 0o755);
});

test('win32 installs dependencies inside every private run without projection reuse', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-install-win32-fallback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const descriptor = await createKitFixture(root, 'alpha');
  const cacheRoot = path.join(root, 'cache');
  const npmFixture = await createRecordingPnpmFixture(root);

  const first = await ensureKitInstall({
    descriptor,
    cacheRoot,
    pnpmExecutable: npmFixture.executable,
    runtimePlatform: 'win32',
  });
  const second = await ensureKitInstall({
    descriptor,
    cacheRoot,
    pnpmExecutable: npmFixture.executable,
    runtimePlatform: 'win32',
  });
  const calls = (await readFile(npmFixture.logFile, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

  assert.equal(first.reused, false);
  assert.equal(second.reused, false);
  assert.notEqual(first.runRoot, second.runRoot);
  assert.deepEqual(calls, [
    { command: 'install', installRoot: first.installRoot },
    { command: 'rebuild', installRoot: first.installRoot },
    { command: 'install', installRoot: second.installRoot },
    { command: 'rebuild', installRoot: second.installRoot },
  ]);
  await assert.rejects(access(path.join(cacheRoot, 'templates')));

  await rm(first.runRoot, { recursive: true });
  await rm(second.runRoot, { recursive: true });
  await assert.rejects(access(first.runRoot));
  await assert.rejects(access(second.runRoot));
  assert.deepEqual(await readdir(path.join(cacheRoot, 'runs')), []);
});

test('installs dev dependencies deterministically and sanitizes lifecycle environment', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-install-environment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const descriptor = await createKitFixture(root, 'alpha');
  await writeFile(path.join(descriptor.directory, '.npmrc'), 'legacy-peer-deps=true\n');
  const cacheRoot = path.join(root, 'cache');
  const npmFixture = await createEnvironmentSensitivePnpmFixture(root);
  const controlledEnvironment = {
    NODE_ENV: 'production',
    npm_config_omit: 'dev',
    NPM_CONFIG_INCLUDE: 'prod',
    NODE_AUTH_TOKEN: 'node-secret',
    npm_token: 'npm-secret',
    GITHUB_TOKEN: 'github-secret',
    gh_token: 'gh-secret',
  };
  const previous = Object.fromEntries(
    Object.keys(controlledEnvironment).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, controlledEnvironment);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const first = await ensureKitInstall({
    descriptor,
    cacheRoot,
    pnpmExecutable: npmFixture.executable,
  });
  for (const key of Object.keys(controlledEnvironment)) delete process.env[key];
  const second = await ensureKitInstall({
    descriptor,
    cacheRoot,
    pnpmExecutable: npmFixture.executable,
  });
  const calls = (await readFile(npmFixture.logFile, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

  assert.equal(await readFile(path.join(first.installRoot, 'node_modules', 'dev-tool'), 'utf8'), 'installed');
  assert.equal(await readFile(path.join(second.installRoot, 'node_modules', 'dev-tool'), 'utf8'), 'installed');
  assert.equal(second.cacheKey, first.cacheKey);
  assert.equal(second.reused, true);
  assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), [
    { command: 'install', args: [
      '--frozen-lockfile',
      '--ignore-scripts',
    ] },
    { command: 'rebuild', args: [] },
    { command: 'rebuild', args: [] },
  ]);
  assert.ok(calls.every(({ selection }) => Object.keys(selection).length === 0));
  assert.deepEqual(calls[0].tokens, {
    NODE_AUTH_TOKEN: 'node-secret',
    npm_token: 'npm-secret',
    GITHUB_TOKEN: 'github-secret',
    gh_token: 'gh-secret',
  });
  assert.ok(calls.slice(1).every(({ tokens }) => Object.keys(tokens).length === 0));
});

test('a changed Kit npm configuration misses the dependency cache', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-install-npmrc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const descriptor = await createKitFixture(root, 'alpha');
  const cacheRoot = path.join(root, 'cache');
  const first = await ensureKitInstall({ descriptor, cacheRoot, pnpmExecutable: descriptor.pnpmExecutable });

  await writeFile(path.join(descriptor.directory, '.npmrc'), 'legacy-peer-deps=true\n');
  const second = await ensureKitInstall({ descriptor, cacheRoot, pnpmExecutable: descriptor.pnpmExecutable });

  assert.equal(second.reused, false);
  assert.notEqual(second.cacheKey, first.cacheKey);
  assert.notEqual(second.dependencyRoot, first.dependencyRoot);
});

test('rejects a dependency template changed after cache validation and cleans the private run', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-install-cache-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const descriptor = await createKitFixture(root, 'alpha');
  const pnpmExecutable = await createPnpmFixture(root, `
    await writeFile(path.join(installRoot, 'node_modules', 'victim'), 'A');
  `);
  const cacheRoot = path.join(root, 'cache');
  const first = await ensureKitInstall({ descriptor, cacheRoot, pnpmExecutable });
  await rm(first.runRoot, { recursive: true });
  let hookCalled = false;

  await assert.rejects(
    ensureKitInstall({
      descriptor,
      cacheRoot,
      pnpmExecutable,
      testHooks: {
        afterProjectionValidation: async () => {
          hookCalled = true;
          await writeFile(path.join(first.dependencyRoot, 'node_modules', 'victim'), 'B');
        },
      },
    }),
    /dependency template changed while restoring/iu,
  );

  assert.equal(hookCalled, true);
  assert.deepEqual(await readdir(path.join(cacheRoot, 'runs')), []);
});

test('rejects a Framework symlink injected after source validation and cleans the private run', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-install-framework-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const descriptor = await createKitFixture(root, 'alpha');
  const outside = path.join(root, 'outside.txt');
  await writeFile(outside, 'outside\n');
  const cacheRoot = path.join(root, 'cache');
  let hookCalled = false;

  await assert.rejects(
    ensureKitInstall({
      descriptor,
      cacheRoot,
      pnpmExecutable: descriptor.pnpmExecutable,
      testHooks: {
        beforeFrameworkSnapshotInjection: async () => {
          hookCalled = true;
          await symlink(outside, path.join(root, 'scripts', 'race-link'));
        },
      },
    }),
    /Framework snapshot.*symbolic link/iu,
  );

  assert.equal(hookCalled, true);
  assert.deepEqual(await readdir(path.join(cacheRoot, 'runs')), []);
});

test('rejects an escaping projection symlink and rebuilds the completed template', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-install-corrupt-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const descriptor = await createKitFixture(root, 'alpha');
  const cacheRoot = path.join(root, 'cache');
  const first = await ensureKitInstall({ descriptor, cacheRoot, pnpmExecutable: descriptor.pnpmExecutable });
  await symlink(root, path.join(first.dependencyRoot, 'node_modules', 'escape'));

  const repaired = await ensureKitInstall({ descriptor, cacheRoot, pnpmExecutable: descriptor.pnpmExecutable });

  assert.equal(repaired.reused, false);
  await assert.rejects(access(path.join(repaired.dependencyRoot, 'node_modules', 'escape')));
});

test('preserves valid npm workspace links and keeps them inside template and install roots', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-install-workspace-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const descriptor = await createKitFixture(root, 'alpha');
  const metadata = await readKitMetadata(descriptor);
  metadata.packageJson.dependencies = { '@example/workspace': 'workspace:*' };
  metadata.lock.importers['.'].dependencies = {
    '@example/workspace': { specifier: 'workspace:*', version: 'link:packages/workspace' },
  };
  metadata.lock.importers['packages/workspace'] = {};
  await writeFile(
    path.join(descriptor.directory, 'pnpm-workspace.yaml'),
    "packages:\n  - 'packages/*'\n",
  );
  await mkdir(path.join(descriptor.directory, 'packages', 'workspace'), { recursive: true });
  await writeFile(
    path.join(descriptor.directory, 'packages', 'workspace', 'package.json'),
    '{"name":"@example/workspace","version":"1.0.0"}\n',
  );
  await writeKitMetadata(metadata);

  const result = await ensureKitInstall({ descriptor, cacheRoot: path.join(root, 'cache'), pnpmExecutable: descriptor.pnpmExecutable });
  const relativeLink = path.join('node_modules', '@example', 'workspace');

  assert.equal((await lstat(path.join(result.dependencyRoot, relativeLink))).isSymbolicLink(), true);
  assert.equal(await readlink(path.join(result.dependencyRoot, relativeLink)), '../../packages/workspace');
  assert.equal((await lstat(path.join(result.installRoot, relativeLink))).isSymbolicLink(), true);
  assert.equal(
    path.resolve(path.dirname(path.join(result.installRoot, relativeLink)), await readlink(path.join(result.installRoot, relativeLink))),
    path.join(result.installRoot, 'packages', 'workspace'),
  );
});

test('different Kits never share an install root', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-install-roots-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const alpha = await createKitFixture(root, 'alpha');
  const zeta = await createKitFixture(root, 'zeta');
  const cacheRoot = path.join(root, 'cache');

  const [alphaInstall, zetaInstall] = await Promise.all([
    ensureKitInstall({ descriptor: alpha, cacheRoot, pnpmExecutable: alpha.pnpmExecutable }),
    ensureKitInstall({ descriptor: zeta, cacheRoot, pnpmExecutable: zeta.pnpmExecutable }),
  ]);

  assert.notEqual(alphaInstall.installRoot, zetaInstall.installRoot);
});

test('concurrent installs share one completed dependency template without sharing work roots', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-install-concurrent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const descriptor = await createKitFixture(root, 'alpha');
  const cacheRoot = path.join(root, 'cache');

  const [left, right] = await Promise.all([
    ensureKitInstall({ descriptor, cacheRoot, pnpmExecutable: descriptor.pnpmExecutable }),
    ensureKitInstall({ descriptor, cacheRoot, pnpmExecutable: descriptor.pnpmExecutable }),
  ]);

  assert.equal(left.dependencyRoot, right.dependencyRoot);
  assert.notEqual(left.runRoot, right.runRoot);
  assert.notEqual(left.installRoot, right.installRoot);
  assert.deepEqual(new Set([left.reused, right.reused]), new Set([false, true]));
  assert.equal(
    JSON.parse(await readFile(path.join(left.dependencyRoot, '.harbors-kit-install.json'), 'utf8')).slug,
    'alpha',
  );
});

test('rejects package and lock drift before consulting an existing cache', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-install-drift-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const descriptor = await createKitFixture(root, 'alpha');
  const cacheRoot = path.join(root, 'cache');
  await ensureKitInstall({ descriptor, cacheRoot, pnpmExecutable: descriptor.pnpmExecutable });
  const packageFile = path.join(descriptor.directory, 'package.json');
  const packageJson = JSON.parse(await readFile(packageFile, 'utf8'));
  packageJson.dependencies = { 'drift-dep': '1.0.0' };
  await writeFile(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`);

  await assert.rejects(
    ensureKitInstall({ descriptor, cacheRoot, pnpmExecutable: descriptor.pnpmExecutable }),
    /pnpm-lock.*package.json|drift/iu,
  );
});

test('rejects descriptor identity drift before creating cache state', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-install-descriptor-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const descriptor = await createKitFixture(root, 'alpha');
  for (const override of [
    { id: '@example/wrong' },
    { version: '9.9.9' },
  ]) {
    const cacheRoot = path.join(root, `cache-${Object.keys(override)[0]}`);
    await assert.rejects(
      ensureKitInstall({ descriptor: { ...descriptor, ...override }, cacheRoot, pnpmExecutable: descriptor.pnpmExecutable }),
      /descriptor\.(?:id|version).*Kit package/u,
    );
    await assert.rejects(access(cacheRoot));
  }
});

test('rejects cache roots that overlap the Kit before writing cache state', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-install-cache-overlap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const descriptor = await createKitFixture(root, 'alpha');
  const cacheRoot = path.join(descriptor.directory, '.cache', 'installs');

  await assert.rejects(
    ensureKitInstall({ descriptor, cacheRoot, pnpmExecutable: descriptor.pnpmExecutable }),
    /cacheRoot.*overlap.*Kit/iu,
  );
  await assert.rejects(access(path.join(descriptor.directory, '.cache')));
});

test('rejects cache roots overlapping Framework snapshot inputs before writing cache state', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-install-framework-cache-overlap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const descriptor = await createKitFixture(root, 'alpha');
  for (const cacheRoot of [
    path.join(root, 'packages', 'custom-cache'),
    path.join(root, 'plugins', 'custom-cache'),
    path.join(root, 'scripts', 'custom-cache'),
    path.join(root, 'node_modules', 'custom-cache'),
  ]) {
    await assert.rejects(
      ensureKitInstall({ descriptor, cacheRoot, pnpmExecutable: descriptor.pnpmExecutable }),
      /cacheRoot.*overlap.*Framework/iu,
    );
    await assert.rejects(access(cacheRoot));
  }
});

test('rejects cache templates and runs symlinks without writing through them', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-install-cache-component-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pnpmExecutable = await createPnpmFixture(root);
  for (const component of ['templates', 'runs']) {
    const descriptor = await createKitFixture(root, `alpha-${component}`);
    const cacheRoot = path.join(root, `cache-${component}`);
    const outside = path.join(root, `outside-${component}`);
    await mkdir(cacheRoot);
    await mkdir(outside);
    await symlink(outside, path.join(cacheRoot, component));

    await assert.rejects(
      ensureKitInstall({ descriptor, cacheRoot, pnpmExecutable }),
      /cache.*(?:symbolic link|contained|directory)/iu,
    );
    assert.deepEqual(await readdir(outside), [], component);
  }
});

test('rejects a cache component replaced with a symlink after validation', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-install-cache-component-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const descriptor = await createKitFixture(root, 'alpha');
  const cacheRoot = path.join(root, 'cache');
  const outside = path.join(root, 'outside');
  await mkdir(path.join(cacheRoot, 'templates'), { recursive: true });
  await mkdir(outside);
  let hookCalled = false;

  await assert.rejects(
    ensureKitInstall({
      descriptor,
      cacheRoot,
      pnpmExecutable: await createPnpmFixture(root),
      testHooks: {
        beforeTemplateDirectoryUse: async () => {
          hookCalled = true;
          await rm(path.join(cacheRoot, 'templates'), { recursive: true });
          await symlink(outside, path.join(cacheRoot, 'templates'));
        },
      },
    }),
    /cache.*(?:symbolic link|contained|directory)/iu,
  );

  assert.equal(hookCalled, true);
  assert.deepEqual(await readdir(outside), []);
});

test('rejects source and Framework snapshot symlinks before copying them', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-install-source-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const descriptor = await createKitFixture(root, 'alpha');
  const outside = path.join(root, 'outside.txt');
  await writeFile(outside, 'outside\n');
  await symlink(outside, path.join(descriptor.directory, 'source-link'));
  await assert.rejects(
    ensureKitInstall({ descriptor, cacheRoot: path.join(root, 'cache-source'), pnpmExecutable: descriptor.pnpmExecutable }),
    /Kit source.*symbolic link/iu,
  );

  await rm(path.join(descriptor.directory, 'source-link'));
  await symlink(outside, path.join(root, 'scripts', 'framework-link'));
  await assert.rejects(
    ensureKitInstall({ descriptor, cacheRoot: path.join(root, 'cache-framework'), pnpmExecutable: descriptor.pnpmExecutable }),
    /Framework snapshot.*symbolic link/iu,
  );
});

test('rejects cross-platform local dependency escapes in root, workspace, and lock metadata', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-install-portable-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pnpmExecutable = await createPnpmFixture(root);
  const cases = [
    ['peer file escape', async (descriptor, metadata) => {
      metadata.packageJson.peerDependencies = { bad: 'file:../../outside' };
      metadata.lock.importers['.'].peerDependencies = toImporterDependencies(metadata.packageJson.peerDependencies);
    }],
    ['manifest link escape', async (descriptor, metadata) => {
      metadata.packageJson.dependencies = { bad: 'link:../../outside' };
      metadata.lock.importers['.'].dependencies = toImporterDependencies(metadata.packageJson.dependencies);
    }],
    ['lock naked link escape', async (descriptor, metadata) => {
      metadata.packageJson.dependencies = { bad: '1.0.0' };
      metadata.lock.importers['.'].dependencies = { bad: { specifier: '1.0.0', version: 'link:../../outside' } };
    }],
    ['encoded path', async (descriptor, metadata) => {
      metadata.packageJson.dependencies = { bad: 'file:%2e%2e/outside' };
      metadata.lock.importers['.'].dependencies = toImporterDependencies(metadata.packageJson.dependencies);
    }],
    ['backslash path', async (descriptor, metadata) => {
      metadata.packageJson.dependencies = { bad: 'file:..\\..\\outside' };
      metadata.lock.importers['.'].dependencies = toImporterDependencies(metadata.packageJson.dependencies);
    }],
    ['drive path', async (descriptor, metadata) => {
      metadata.packageJson.dependencies = { bad: 'file:C:/outside' };
      metadata.lock.importers['.'].dependencies = toImporterDependencies(metadata.packageJson.dependencies);
    }],
    ['bare POSIX absolute path', async (descriptor, metadata) => {
      metadata.packageJson.dependencies = { bad: '/tmp/outside' };
      metadata.lock.importers['.'].dependencies = toImporterDependencies(metadata.packageJson.dependencies);
    }],
    ['bare parent path', async (descriptor, metadata) => {
      metadata.packageJson.dependencies = { bad: '../../outside' };
      metadata.lock.importers['.'].dependencies = toImporterDependencies(metadata.packageJson.dependencies);
    }],
    ['bare current-directory path', async (descriptor, metadata) => {
      await mkdir(path.join(descriptor.directory, 'inside'));
      await writeFile(path.join(descriptor.directory, 'inside', 'package.json'), '{"name":"inside","version":"1.0.0"}\n');
      metadata.packageJson.dependencies = { bad: './inside' };
      metadata.lock.importers['.'].dependencies = toImporterDependencies(metadata.packageJson.dependencies);
    }],
    ['bare Windows drive path', async (descriptor, metadata) => {
      metadata.packageJson.dependencies = { bad: 'C:\\outside' };
      metadata.lock.importers['.'].dependencies = toImporterDependencies(metadata.packageJson.dependencies);
    }],
    ['bare UNC path', async (descriptor, metadata) => {
      metadata.packageJson.dependencies = { bad: '\\\\server\\share' };
      metadata.lock.importers['.'].dependencies = toImporterDependencies(metadata.packageJson.dependencies);
    }],
    ['bare encoded traversal', async (descriptor, metadata) => {
      metadata.packageJson.dependencies = { bad: '%2e%2e%2foutside' };
      metadata.lock.importers['.'].dependencies = toImporterDependencies(metadata.packageJson.dependencies);
    }],
    ['unknown workspace dependency', async (descriptor, metadata) => {
      metadata.packageJson.dependencies = { '@example/missing': 'workspace:*' };
      metadata.lock.importers['.'].dependencies = toImporterDependencies(metadata.packageJson.dependencies);
    }],
    ['unsafe package path', async (descriptor, metadata) => {
      metadata.lock.packages['/bad@1.0.0'] = { resolution: { tarball: 'file:../../outside' } };
    }],
    ['workspace-owned escape', async (descriptor, metadata) => {
      metadata.packageJson.dependencies = { '@example/workspace': 'workspace:*' };
      metadata.lock.importers['.'].dependencies = {
        '@example/workspace': { specifier: 'workspace:*', version: 'link:packages/workspace' },
      };
      metadata.lock.importers['packages/workspace'] = {
        dependencies: { bad: { specifier: 'file:../../../outside', version: 'file:../../../outside' } },
      };
      await writeFile(
        path.join(descriptor.directory, 'pnpm-workspace.yaml'),
        "packages:\n  - 'packages/*'\n",
      );
      await mkdir(path.join(descriptor.directory, 'packages', 'workspace'), { recursive: true });
      await writeFile(
        path.join(descriptor.directory, 'packages', 'workspace', 'package.json'),
        '{"name":"@example/workspace","version":"1.0.0","dependencies":{"bad":"file:../../../outside"}}\n',
      );
    }],
  ];
  for (const [name, mutate] of cases) {
    const descriptor = await createKitFixture(root, name.toLowerCase().replaceAll(' ', '-'));
    const metadata = await readKitMetadata(descriptor);
    await mutate(descriptor, metadata);
    await writeKitMetadata(metadata);
    const cacheRoot = path.join(root, `cache-${descriptor.slug}`);
    await assert.rejects(
      ensureKitInstall({ descriptor, cacheRoot, pnpmExecutable }),
      /dependency|pnpm-lock|portable relative path/iu,
      name,
    );
    await assert.rejects(access(cacheRoot), name);
  }
});

test('rejects product lock file dependencies that escape the Kit root', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-install-file-dependency-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const descriptor = await createKitFixture(root, 'alpha');
  const packageFile = path.join(descriptor.directory, 'package.json');
  const lockFile = path.join(descriptor.directory, 'pnpm-lock.yaml');
  const packageJson = JSON.parse(await readFile(packageFile, 'utf8'));
  const lock = parseYaml(await readFile(lockFile, 'utf8'));
  packageJson.dependencies = { '@example/shared': 'file:../../packages/shared' };
  lock.importers['.'].dependencies = {
    '@example/shared': { specifier: 'file:../../packages/shared', version: 'file:../../packages/shared' },
  };
  await writeFile(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeFile(lockFile, `${stringifyYaml(lock)}\n`);

  await assert.rejects(
    ensureKitInstall({ descriptor, cacheRoot: path.join(root, 'cache'), pnpmExecutable: descriptor.pnpmExecutable }),
    /file dependency.*Kit root/iu,
  );
});
