import path from 'node:path';

import { BUILD_CACHE_RELATIVE_DIR } from './build-cache-contract.mjs';
import { discoverAllPlugins, discoverPlugin, discoverRuntimePlugins } from './plugin-build/discover.mjs';

const NOTIFICATION_BACKGROUND_PLUGIN = 'kits/notifications/plugins/notification-background';
const NOTIFY_USER_RESOURCE_OUTPUT = `${NOTIFICATION_BACKGROUND_PLUGIN}/main/dist/resources/notify-user`;

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
export const WORKSPACE_BUILD_OUTPUTS = Object.freeze(
  WORKSPACE_TASKS.flatMap((task) => task.outputs),
);

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
  const allPluginTasks = discoverAllPlugins(rootPath)
    .map((pluginDir) => createPluginTask(rootPath, pluginDir));
  const selectedPluginDirectories = new Set(
    (selection.plugins === 'runtime'
      ? discoverRuntimePlugins(rootPath)
      : discoverAllPlugins(rootPath))
      .map((pluginDir) => toRepositoryPath(rootPath, pluginDir)),
  );
  const pluginTasks = allPluginTasks.filter((task) => selectedPluginDirectories.has(task.pluginDir));
  const notificationResourceTask = createNotificationResourceTask();
  const taskUniverse = [
    ...WORKSPACE_TASKS,
    ...allPluginTasks,
    notificationResourceTask,
  ];
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
    ...(selection.notificationResource ? [notificationResourceTask] : []),
  ];

  validateBuildTasks(tasks, taskUniverse);
  return { cacheDir: path.join(rootPath, BUILD_CACHE_RELATIVE_DIR), tasks };
}

export function validateBuildTasks(tasks, taskUniverse = tasks) {
  const taskOwnership = taskUniverse.map((task) => {
    const outputs = task.outputs.map(canonicalTaskPath);
    const outputExcludes = new Set((task.outputExcludes ?? []).map(canonicalTaskPath));
    for (const outputExclude of outputExcludes) {
      if (!outputs.some((output) => isNestedOutput(outputExclude, output))) {
        throw new Error(
          `Output exclusion "${outputExclude}" for ${task.name} is outside its declared output roots`,
        );
      }
    }
    return { name: task.name, outputExcludes, outputs };
  });
  const outputOwners = taskOwnership.flatMap((task) => task.outputs.map((output) => ({
    name: task.name,
    output,
    outputExcludes: task.outputExcludes,
  })));

  for (const task of taskOwnership) {
    for (const outputExclude of task.outputExcludes) {
      if (!outputOwners.some((owner) => (
        owner.name !== task.name && owner.output === outputExclude
      ))) {
        throw new Error(
          `Output exclusion "${outputExclude}" for ${task.name} is not the exact output root of another task`,
        );
      }
    }
  }

  for (let index = 0; index < outputOwners.length; index += 1) {
    const owner = outputOwners[index];
    for (const candidate of outputOwners.slice(index + 1)) {
      if (candidate.output === owner.output) {
        throw new Error(
          `Duplicate build output root "${owner.output}" claimed by ${owner.name} and ${candidate.name}`,
        );
      }
      if (isNestedOutput(candidate.output, owner.output)
        && !owner.outputExcludes.has(candidate.output)) {
        throw outputOwnershipError({
          childName: candidate.name,
          childOutput: candidate.output,
          parentName: owner.name,
          parentOutput: owner.output,
        });
      }
      if (isNestedOutput(owner.output, candidate.output)
        && !candidate.outputExcludes.has(owner.output)) {
        throw outputOwnershipError({
          childName: owner.name,
          childOutput: owner.output,
          parentName: candidate.name,
          parentOutput: candidate.output,
        });
      }
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
  const outputExcludes = repositoryPluginDir === NOTIFICATION_BACKGROUND_PLUGIN
    ? [NOTIFY_USER_RESOURCE_OUTPUT]
    : [];

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
    ...(outputExcludes.length > 0 ? { outputExcludes } : {}),
    dependencies: workspaceDependencies,
  };
}

function createNotificationResourceTask() {
  return {
    name: 'resource:notify-user',
    kind: 'resource',
    command: { file: 'node', args: ['scripts/prepare-notification-skill-resource.mjs'] },
    inputs: [
      '.agents/skills/notify-user',
      'scripts/prepare-notification-skill-resource.mjs',
      'scripts/lib/codex-skill-resource.mjs',
    ],
    outputs: [NOTIFY_USER_RESOURCE_OUTPUT],
    dependencies: [`plugin:${NOTIFICATION_BACKGROUND_PLUGIN}`],
  };
}

function isNestedOutput(candidate, parent) {
  return candidate.startsWith(`${parent}/`);
}

function canonicalTaskPath(taskPath) {
  if (typeof taskPath !== 'string' || path.posix.isAbsolute(taskPath)) {
    throw new Error(`Build task path must be repository-relative: ${taskPath}`);
  }
  const canonicalPath = path.posix.normalize(taskPath);
  if (canonicalPath === '..' || canonicalPath.startsWith('../')) {
    throw new Error(`Build task path escapes the repository: ${taskPath}`);
  }
  return canonicalPath;
}

function outputOwnershipError({ childName, childOutput, parentName, parentOutput }) {
  return new Error(
    `Output root "${childOutput}" claimed by ${childName} overlaps ${parentName} output root "${parentOutput}" without an exact exclusion`,
  );
}

function toRepositoryPath(rootDir, value) {
  return path.relative(rootDir, value).split(path.sep).join('/');
}
