import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { discoverAllPlugins, discoverPlugin, discoverRuntimePlugins } from './plugin-build/discover.mjs';
import { createBuildPlan, validateBuildTasks } from './build-tasks.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('selects the runtime workspace builds and runtime plugins in root build order', () => {
  const runtime = createBuildPlan(rootDir, 'runtime');

  assert.deepEqual(
    runtime.tasks.filter((task) => task.kind === 'plugin').map((task) => task.pluginDir),
    discoverRuntimePlugins(rootDir).map((value) => path.relative(rootDir, value)),
  );
  assert.deepEqual(runtime.tasks.slice(0, 5).map(({ name }) => name), [
    'workspace:plugin-types',
    'workspace:kit-core',
    'workspace:kit-cli',
    'workspace:client',
    'workspace:server',
  ]);
});

test('selects every full build task before all plugins and notification resources', () => {
  const all = createBuildPlan(rootDir, 'all');
  const workspaceNames = [
    'workspace:plugin-types',
    'workspace:csv-contracts',
    'workspace:sqlite-contracts',
    'workspace:mysql-contracts',
    'workspace:relationship-graph',
    'workspace:kit-core',
    'workspace:kit-cli',
    'workspace:client',
    'workspace:server',
  ];

  assert.equal(all.cacheDir, path.join(rootDir, '.cache', 'harbors-build', 'v1'));
  assert.deepEqual(all.tasks.slice(0, workspaceNames.length).map(({ name }) => name), workspaceNames);
  assert.deepEqual(
    all.tasks.filter((task) => task.kind === 'plugin').map((task) => task.pluginDir),
    discoverAllPlugins(rootDir).map((value) => path.relative(rootDir, value)),
  );
  assert.deepEqual(all.tasks.at(-1), {
    name: 'resource:notify-user',
    kind: 'resource',
    command: { file: 'node', args: ['scripts/prepare-notification-skill-resource.mjs'] },
    inputs: [
      '.agents/skills/notify-user',
      'scripts/prepare-notification-skill-resource.mjs',
      'scripts/lib/codex-skill-resource.mjs',
    ],
    outputs: ['kits/notifications/plugins/notification-background/main/dist/resources/notify-user'],
    dependencies: ['plugin:kits/notifications/plugins/notification-background'],
  });
  assert.deepEqual(
    all.tasks.find((task) => task.name === 'plugin:kits/notifications/plugins/notification-background').outputExcludes,
    ['kits/notifications/plugins/notification-background/main/dist/resources/notify-user'],
  );
});

test('omits workspace tasks from plugin-only plans while retaining selected task ordering', () => {
  const plugins = createBuildPlan(rootDir, 'plugins');
  const runtimePlugins = createBuildPlan(rootDir, 'plugins-runtime');

  assert.ok(plugins.tasks.every((task) => task.kind !== 'workspace'));
  assert.deepEqual(
    plugins.tasks.filter((task) => task.kind === 'plugin').map((task) => task.pluginDir),
    discoverAllPlugins(rootDir).map((value) => path.relative(rootDir, value)),
  );
  assert.deepEqual(
    runtimePlugins.tasks.filter((task) => task.kind === 'plugin').map((task) => task.pluginDir),
    discoverRuntimePlugins(rootDir).map((value) => path.relative(rootDir, value)),
  );
  assert.deepEqual(
    plugins.tasks.at(-1).dependencies,
    ['plugin:kits/notifications/plugins/notification-background'],
  );
});

test('tracks workspace dependency outputs as plugin inputs and retains their task dependencies only when selected', () => {
  const pluginDir = 'kits/mysql/plugins/mysql-relationships';
  const allPlugin = createBuildPlan(rootDir, 'all').tasks.find((task) => task.pluginDir === pluginDir);
  const pluginOnly = createBuildPlan(rootDir, 'plugins').tasks.find((task) => task.pluginDir === pluginDir);

  assert.deepEqual(allPlugin.dependencies, [
    'workspace:mysql-contracts',
    'workspace:relationship-graph',
  ]);
  assert.deepEqual(pluginOnly.dependencies, []);
  assert.deepEqual(allPlugin.inputs.filter((input) => input.startsWith('packages/')), [
    'packages/mysql-contracts/dist',
    'packages/relationship-graph/dist',
  ]);
  assert.deepEqual(pluginOnly.inputs.filter((input) => input.startsWith('packages/')), [
    'packages/mysql-contracts/dist',
    'packages/relationship-graph/dist',
  ]);
  assert.deepEqual(allPlugin.outputs, [
    ...pluginOutputRoots(pluginDir),
  ]);
  assert.ok(allPlugin.outputs.every((output) => !allPlugin.inputs.includes(output)));
});

test('rejects unknown build graphs', () => {
  assert.throws(() => createBuildPlan(rootDir, 'unknown'), /Unknown build graph: unknown/);
});

test('rejects duplicate and unowned nested output roots', () => {
  assert.throws(
    () => validateBuildTasks([
      { name: 'first', outputs: ['shared/dist'] },
      { name: 'second', outputs: ['shared/dist'] },
    ]),
    /Duplicate build output root "shared\/dist" claimed by first and second/,
  );
  assert.throws(
    () => validateBuildTasks([
      { name: 'parent', outputs: ['shared/dist'] },
      { name: 'child', outputs: ['shared/dist/resources'] },
    ]),
    /Output root "shared\/dist\/resources" claimed by child overlaps parent output root "shared\/dist" without an exact exclusion/,
  );
  assert.doesNotThrow(() => validateBuildTasks([
    {
      name: 'parent',
      outputs: ['shared/dist'],
      outputExcludes: ['shared/dist/resources'],
    },
    { name: 'child', outputs: ['shared/dist/resources'] },
  ]));
  assert.throws(
    () => validateBuildTasks([
      {
        name: 'parent',
        outputs: ['shared/dist'],
        outputExcludes: ['shared/dist/owned-by-someone-else'],
      },
      { name: 'child', outputs: ['shared/dist/resources'] },
    ]),
    /Output root "shared\/dist\/resources" claimed by child overlaps parent output root "shared\/dist" without an exact exclusion/,
  );
  assert.throws(
    () => validateBuildTasks([
      {
        name: 'parent',
        outputs: ['shared/dist'],
        outputExcludes: ['other-task/dist'],
      },
    ]),
    /Output exclusion "other-task\/dist" for parent is outside its declared output roots/,
  );
  assert.throws(
    () => validateBuildTasks([
      { name: 'first', outputs: ['shared/a/../dist'] },
      { name: 'second', outputs: ['shared/dist'] },
    ]),
    /Duplicate build output root "shared\/dist" claimed by first and second/,
  );
});

test('declares only existing source inputs for the client workspace build', () => {
  const client = createBuildPlan(rootDir, 'all').tasks.find((task) => task.name === 'workspace:client');

  for (const input of client.inputs) {
    assert.equal(existsSync(path.join(rootDir, input)), true, `${client.name} declares missing input ${input}`);
  }
});

test('tracks compiler configs extended by the client and server build configs', () => {
  const tasks = createBuildPlan(rootDir, 'all').tasks;
  const client = tasks.find((task) => task.name === 'workspace:client');
  const server = tasks.find((task) => task.name === 'workspace:server');

  assert.ok(client.inputs.includes('packages/client/tsconfig.json'));
  assert.ok(server.inputs.includes('packages/server/tsconfig.json'));
});

function pluginOutputRoots(pluginDir) {
  const plugin = discoverPlugin(path.join(rootDir, pluginDir));
  return [
    ...(plugin.main ? [path.relative(rootDir, plugin.main.distDir)] : []),
    ...plugin.panels.map((panel) => path.relative(rootDir, panel.distDir)),
  ];
}
