import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { discoverAllPlugins } from './plugin-build/discover.mjs';
import {
  createBuildPlan,
  discoverWorkspaceBuildOutputs,
  validateBuildTasks,
} from './build-tasks.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('discovers buildable Framework workspaces and orders their package dependencies first', async (t) => {
  const fixture = await createWorkspaceFixture(t, [
    { directory: 'consumer', name: '@fixture/consumer', dependencies: { '@fixture/foundation': '1.0.0' } },
    { directory: 'foundation', name: '@fixture/foundation' },
    { directory: 'no-build', name: '@fixture/no-build', build: false },
  ]);

  const plan = await createBuildPlan(fixture, 'all', { descriptors: [] });

  assert.deepEqual(plan.tasks.map((task) => task.name), [
    'workspace:foundation',
    'workspace:consumer',
  ]);
  assert.deepEqual(plan.tasks[1].dependencies, ['workspace:foundation']);
  assert.deepEqual(plan.tasks[1].command, {
    file: 'pnpm',
    args: ['--filter', '@fixture/consumer', 'run', 'build'],
  });
  assert.ok(plan.tasks[1].inputs.includes('pnpm-lock.yaml'));
  assert.ok(plan.tasks[1].inputs.includes('packages/foundation/dist'));
  assert.deepEqual(discoverWorkspaceBuildOutputs(fixture), [
    'packages/foundation/dist',
    'packages/consumer/dist',
  ]);
});

test('rejects dynamic Framework workspace dependency cycles', async (t) => {
  const fixture = await createWorkspaceFixture(t, [
    { directory: 'alpha', name: '@fixture/alpha', dependencies: { '@fixture/zeta': '1.0.0' } },
    { directory: 'zeta', name: '@fixture/zeta', dependencies: { '@fixture/alpha': '1.0.0' } },
  ]);

  await assert.rejects(
    createBuildPlan(fixture, 'all', { descriptors: [] }),
    /Framework workspace build dependency cycle/u,
  );
});

test('keeps the complete Framework build graph free of product Kit tasks', async () => {
  const plan = await createBuildPlan(rootDir, 'all');
  const buildablePackages = await discoverBuildablePackageDirectories(rootDir);
  const rootPlugins = discoverAllPlugins(rootDir)
    .filter((directory) => path.dirname(directory) === path.join(rootDir, 'plugins'))
    .map((directory) => path.relative(rootDir, directory));

  assert.equal(plan.cacheDir, path.join(rootDir, '.cache', 'harbors-build', 'v1'));
  assert.deepEqual(
    plan.tasks.filter((task) => task.kind === 'workspace').map((task) => task.outputs[0]).sort(),
    buildablePackages.map((directory) => (
      directory === 'packages/native-credential-vault'
        ? `${directory}/build`
        : `${directory}/dist`
    )).sort(),
  );
  assert.deepEqual(
    plan.tasks.filter((task) => task.kind === 'plugin').map((task) => task.pluginDir),
    rootPlugins,
  );
  assert.equal(plan.tasks.some((task) => task.kind === 'kit'), false);
  assert.ok(plan.tasks.every((task) => !task.inputs.some((input) => input.startsWith('kits/'))));
});

test('tracks the native credential workspace by its real build output and complete native inputs', async () => {
  const plan = await createBuildPlan(rootDir, 'all');
  const native = plan.tasks.find((task) => task.name === 'workspace:native-credential-vault');
  const server = plan.tasks.find((task) => task.name === 'workspace:server');

  assert.deepEqual(native.outputs, ['packages/native-credential-vault/build']);
  assert.deepEqual(native.emptyOutputs, ['packages/native-credential-vault/build']);
  assert.ok(native.inputs.includes('packages/native-credential-vault/binding.gyp'));
  assert.ok(native.inputs.includes('packages/native-credential-vault/index.cjs'));
  assert.ok(native.inputs.includes('packages/native-credential-vault/lib'));
  assert.ok(native.inputs.includes('packages/native-credential-vault/scripts'));
  assert.ok(native.inputs.includes('packages/native-credential-vault/src'));
  assert.ok(server.dependencies.includes(native.name));
  assert.ok(server.inputs.includes(native.outputs[0]));
});

test('runtime graphs preserve the plugin toolchain dependency closure without product Kits', async () => {
  const runtime = await createBuildPlan(rootDir, 'runtime');
  const pluginsRuntime = await createBuildPlan(rootDir, 'plugins-runtime');

  assert.ok(runtime.tasks.some((task) => task.kind === 'workspace'));
  assert.ok(pluginsRuntime.tasks.some((task) => task.name === 'workspace:kit-core'));
  assert.ok(pluginsRuntime.tasks.some((task) => task.name === 'workspace:kit-cli'));
  assert.equal(runtime.tasks.some((task) => task.kind === 'kit'), false);
  assert.equal(pluginsRuntime.tasks.some((task) => task.kind === 'kit'), false);
});

test('plugin-only graph includes only the required Framework dependency closure', async () => {
  const plan = await createBuildPlan(rootDir, 'plugins');

  const workspaceNames = new Set(
    plan.tasks.filter((task) => task.kind === 'workspace').map((task) => task.name),
  );
  assert.ok(workspaceNames.has('workspace:kit-core'));
  assert.ok(workspaceNames.has('workspace:kit-cli'));
  assert.equal(plan.tasks.some((task) => task.kind === 'kit'), false);
  for (const task of plan.tasks.filter((candidate) => candidate.kind !== 'workspace')) {
    for (const dependency of task.dependencies) assert.ok(workspaceNames.has(dependency));
  }
});

test('Framework source contains no product Kit, contract, or resource build registrations', async () => {
  const source = await readFile(new URL('build-tasks.mjs', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /NOTIFICATION|notify-user|relationship-graph/u);
  assert.doesNotMatch(source, /kits\/[a-z0-9-]+\/plugins/u);
});

test('Framework hosts contain no Agent Guard storage identity or dedicated environment plumbing', async () => {
  const sources = await Promise.all([
    'packages/server/src/server.ts',
    'packages/server/src/index.ts',
  ].map((relativePath) => readFile(path.join(rootDir, relativePath), 'utf8')));

  assert.doesNotMatch(
    sources.join('\n'),
    /agentGuardDataDir|HARBORS_AGENT_GUARD_DATA_DIR|default-contracts/u,
  );
});

test('rejects unknown build graphs', async () => {
  await assert.rejects(createBuildPlan(rootDir, 'unknown'), /Unknown build graph: unknown/u);
});

test('rejects duplicate and unowned nested output roots', () => {
  assert.throws(
    () => validateBuildTasks([
      { name: 'first', outputs: ['shared/dist'] },
      { name: 'second', outputs: ['shared/dist'] },
    ]),
    /Duplicate build output root "shared\/dist" claimed by first and second/u,
  );
  assert.throws(
    () => validateBuildTasks([
      { name: 'parent', outputs: ['shared/dist'] },
      { name: 'child', outputs: ['shared/dist/resources'] },
    ]),
    /overlaps parent output root/u,
  );
  assert.doesNotThrow(() => validateBuildTasks([
    { name: 'parent', outputs: ['shared/dist'], outputExcludes: ['shared/dist/resources'] },
    { name: 'child', outputs: ['shared/dist/resources'] },
  ]));
  assert.throws(
    () => validateBuildTasks([{
      name: 'parent',
      outputs: ['shared/dist'],
      outputExcludes: ['shared/dist/unowned'],
    }]),
    /is not the exact output root of another task/u,
  );
});

async function createWorkspaceFixture(t, workspaces) {
  const directory = await mkdtemp(path.join(tmpdir(), 'harbors-build-plan-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'packages'), { recursive: true });
  await writeFile(path.join(directory, 'pnpm-lock.yaml'), '');
  await writeFile(path.join(directory, 'tsconfig.json'), '{}');
  for (const workspace of workspaces) {
    const workspaceDirectory = path.join(directory, 'packages', workspace.directory);
    await mkdir(path.join(workspaceDirectory, 'src'), { recursive: true });
    await writeFile(path.join(workspaceDirectory, 'src', 'index.ts'), 'export {};\n');
    await writeFile(path.join(workspaceDirectory, 'tsconfig.json'), '{}');
    await writeFile(path.join(workspaceDirectory, 'package.json'), JSON.stringify({
      name: workspace.name,
      scripts: workspace.build === false ? {} : { build: 'tsc' },
      dependencies: workspace.dependencies,
    }));
  }
  return directory;
}

async function discoverBuildablePackageDirectories(repositoryRoot) {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(path.join(repositoryRoot, 'packages'), { withFileTypes: true });
  const values = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(repositoryRoot, 'packages', entry.name, 'package.json');
    if (!await pathExists(manifestPath)) continue;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (typeof manifest.scripts?.build === 'string') values.push(`packages/${entry.name}`);
  }
  return values.sort();
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function pathExists(candidate) {
  const { access } = await import('node:fs/promises');
  return access(candidate).then(() => true, () => false);
}
