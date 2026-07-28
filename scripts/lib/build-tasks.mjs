import path from 'node:path';

import { discoverAllPlugins, discoverPlugin, discoverRuntimePlugins } from './plugin-build/discover.mjs';

const CACHE_PATH = ['.cache', 'harbors-build', 'v1'];

const WORKSPACE_TASKS = [
  workspaceTask('plugin-types', '@itharbors/plugin-types', 'packages/plugin-types'),
  workspaceTask('csv-contracts', '@itharbors/csv-contracts', 'packages/csv-contracts'),
  workspaceTask('sqlite-contracts', '@itharbors/sqlite-contracts', 'packages/sqlite-contracts'),
  workspaceTask('mysql-contracts', '@itharbors/mysql-contracts', 'packages/mysql-contracts'),
  workspaceTask('relationship-graph', '@itharbors/relationship-graph', 'packages/relationship-graph'),
  workspaceTask('kit-core', '@itharbors/kit-core', 'packages/kit-core'),
  workspaceTask('kit-cli', '@itharbors/kit-cli', 'packages/kit-cli', ['workspace:kit-core']),
  workspaceTask('client', 'packages/client', 'packages/client', ['workspace:plugin-types'], {
    config: [
      'packages/client/tsconfig.build.json',
      'packages/client/tsconfig.json',
      'packages/client/vite.config.ts',
      'packages/client/index.html',
    ],
  }),
  workspaceTask('server', 'packages/server', 'packages/server', ['workspace:plugin-types'], {
    config: ['packages/server/tsconfig.build.json', 'packages/server/tsconfig.json'],
  }),
];

const WORKSPACE_DEPENDENCIES = new Map([
  ['@itharbors/plugin-types', 'workspace:plugin-types'],
  ['@itharbors/csv-contracts', 'workspace:csv-contracts'],
  ['@itharbors/sqlite-contracts', 'workspace:sqlite-contracts'],
  ['@itharbors/mysql-contracts', 'workspace:mysql-contracts'],
  ['@itharbors/relationship-graph', 'workspace:relationship-graph'],
  ['@itharbors/kit-core', 'workspace:kit-core'],
  ['@itharbors/kit-cli', 'workspace:kit-cli'],
]);

const GRAPH_SELECTIONS = {
  all: { workspace: 'all', plugins: 'all', notificationResource: true },
  runtime: { workspace: 'runtime', plugins: 'runtime', notificationResource: false },
  plugins: { workspace: 'none', plugins: 'all', notificationResource: true },
  'plugins-runtime': { workspace: 'none', plugins: 'runtime', notificationResource: false },
};

export function createBuildPlan(rootDir, graphName) {
  const selection = GRAPH_SELECTIONS[graphName];
  if (!selection) throw new Error(`Unknown build graph: ${graphName}`);

  const rootPath = path.resolve(rootDir);
  const workspaceTasks = selectWorkspaceTasks(selection.workspace);
  const pluginDirectories = selection.plugins === 'runtime'
    ? discoverRuntimePlugins(rootPath)
    : discoverAllPlugins(rootPath);
  const pluginTasks = pluginDirectories.map((pluginDir) => createPluginTask(rootPath, pluginDir));
  const selectedTaskNames = new Set([
    ...workspaceTasks.map(({ name }) => name),
    ...pluginTasks.map(({ name }) => name),
  ]);
  const selectedPlugins = pluginTasks.map((task) => ({
    ...task,
    dependencies: task.dependencies.filter((dependency) => selectedTaskNames.has(dependency)),
  }));
  const tasks = [
    ...workspaceTasks,
    ...selectedPlugins,
    ...(selection.notificationResource ? [createNotificationResourceTask()] : []),
  ];

  validateBuildTasks(tasks);
  return { cacheDir: path.join(rootPath, ...CACHE_PATH), tasks };
}

export function validateBuildTasks(tasks) {
  const outputOwners = new Map();
  for (const task of tasks) {
    for (const output of task.outputs) {
      const owner = outputOwners.get(output);
      if (owner) {
        throw new Error(`Duplicate build output root "${output}" claimed by ${owner} and ${task.name}`);
      }
      outputOwners.set(output, task.name);
    }
  }
}

function workspaceTask(slug, workspace, directory, dependencies = [], overrides = {}) {
  const config = overrides.config ?? [`${directory}/tsconfig.json`];
  const sources = overrides.sources ?? [`${directory}/src`];
  return {
    name: `workspace:${slug}`,
    kind: 'workspace',
    command: { file: 'npm', args: ['run', 'build', '-w', workspace] },
    inputs: [
      'package-lock.json',
      'tsconfig.json',
      `${directory}/package.json`,
      ...config,
      ...sources,
    ],
    outputs: [`${directory}/dist`],
    dependencies,
  };
}

function selectWorkspaceTasks(selection) {
  if (selection === 'all') return WORKSPACE_TASKS;
  if (selection === 'runtime') {
    return WORKSPACE_TASKS.filter((task) => [
      'workspace:plugin-types',
      'workspace:kit-core',
      'workspace:kit-cli',
      'workspace:client',
      'workspace:server',
    ].includes(task.name));
  }
  return [];
}

function createPluginTask(rootDir, pluginDir) {
  const plugin = discoverPlugin(pluginDir);
  const repositoryPluginDir = toRepositoryPath(rootDir, plugin.rootDir);
  const workspaceDependencies = Object.keys(plugin.pkg.dependencies ?? {})
    .map((dependency) => WORKSPACE_DEPENDENCIES.get(dependency))
    .filter(Boolean);
  const workspaceOutputs = workspaceDependencies
    .map((dependency) => WORKSPACE_TASKS.find((task) => task.name === dependency).outputs)
    .flat();

  return {
    name: `plugin:${repositoryPluginDir}`,
    kind: 'plugin',
    pluginDir: repositoryPluginDir,
    command: { file: 'node', args: ['scripts/ce-plugin.mjs', 'build', repositoryPluginDir] },
    inputs: [
      'package-lock.json',
      'tsconfig.json',
      'scripts/ce-plugin.mjs',
      'scripts/lib/plugin-build',
      `${repositoryPluginDir}/package.json`,
      ...(plugin.main ? [toRepositoryPath(rootDir, plugin.main.sourceDir)] : []),
      ...plugin.panels.map((panel) => toRepositoryPath(rootDir, panel.sourceDir)),
      ...workspaceOutputs,
    ],
    outputs: [
      ...(plugin.main ? [toRepositoryPath(rootDir, plugin.main.distDir)] : []),
      ...plugin.panels.map((panel) => toRepositoryPath(rootDir, panel.distDir)),
    ],
    dependencies: workspaceDependencies,
  };
}

function createNotificationResourceTask() {
  return {
    name: 'resource:notification-skill',
    kind: 'resource',
    command: { file: 'node', args: ['scripts/prepare-notification-skill-resource.mjs'] },
    inputs: [
      '.agents/skills/notify-user',
      'scripts/prepare-notification-skill-resource.mjs',
      'scripts/lib/codex-skill-resource.mjs',
    ],
    outputs: ['kits/notifications/plugins/notification-background/main/dist/resources/notify-user'],
    dependencies: ['plugin:kits/notifications/plugins/notification-background'],
  };
}

function toRepositoryPath(rootDir, value) {
  return path.relative(rootDir, value).split(path.sep).join('/');
}
