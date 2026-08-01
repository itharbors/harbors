import fs from 'node:fs';
import path from 'node:path';

import { BUILD_CACHE_RELATIVE_DIR } from './build-cache-contract.mjs';

const GRAPH_SELECTIONS = Object.freeze({
  all: { workspaces: true, kits: 'all' },
  runtime: { workspaces: true, kits: 'builtin' },
  plugins: { workspaces: false, kits: 'all' },
  'plugins-runtime': { workspaces: false, kits: 'builtin' },
});

export async function createBuildPlan(rootDir, graphName, options = {}) {
  const selection = GRAPH_SELECTIONS[graphName];
  if (!selection) throw new Error(`Unknown build graph: ${graphName}`);

  const rootPath = path.resolve(rootDir);
  const pluginDiscovery = await import('./plugin-build/discover.mjs');
  const workspaceUniverse = discoverWorkspaceTasks(rootPath);
  const descriptors = options.descriptors ?? await discoverDescriptors(rootPath);
  const rootPluginTasks = discoverRootPluginTasks(rootPath, workspaceUniverse, pluginDiscovery);
  const selectedDescriptors = selection.kits === 'builtin'
    ? descriptors.filter((descriptor) => descriptor.distribution === 'builtin')
    : descriptors;
  const kitTasks = selectedDescriptors.map((descriptor) => (
    createKitTask(rootPath, descriptor, workspaceUniverse, pluginDiscovery)
  ));
  const workspaceTasks = selection.workspaces
    ? workspaceUniverse
    : workspaceDependencyClosure(workspaceUniverse, [...rootPluginTasks, ...kitTasks]);
  const selectedTaskNames = new Set([
    ...workspaceTasks.map((task) => task.name),
    ...rootPluginTasks.map((task) => task.name),
    ...kitTasks.map((task) => task.name),
  ]);
  const tasks = [...workspaceTasks, ...rootPluginTasks, ...kitTasks].map((task) => ({
    ...task,
    dependencies: task.dependencies.filter((dependency) => selectedTaskNames.has(dependency)),
  }));

  validateBuildTasks(tasks);
  return { cacheDir: path.join(rootPath, BUILD_CACHE_RELATIVE_DIR), tasks };
}

async function discoverDescriptors(repositoryRoot) {
  const { discoverRepositoryKits } = await import('./repository-kits.mjs');
  return discoverRepositoryKits({ repositoryRoot });
}

function workspaceDependencyClosure(workspaceUniverse, dependentTasks) {
  const byName = new Map(workspaceUniverse.map((task) => [task.name, task]));
  const selected = new Set(dependentTasks.flatMap((task) => task.dependencies));
  const pending = [...selected];
  while (pending.length > 0) {
    const dependency = pending.pop();
    const task = byName.get(dependency);
    if (!task) continue;
    for (const transitive of task.dependencies) {
      if (selected.has(transitive)) continue;
      selected.add(transitive);
      pending.push(transitive);
    }
  }
  return workspaceUniverse.filter((task) => selected.has(task.name));
}

export function discoverWorkspaceBuildOutputs(rootDir) {
  return discoverWorkspaceTasks(path.resolve(rootDir)).flatMap((task) => task.outputs);
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
      if (!outputOwners.some((owner) => owner.name !== task.name && owner.output === outputExclude)) {
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

function discoverWorkspaceTasks(rootDir) {
  const packagesRoot = path.join(rootDir, 'packages');
  const entries = readDirectories(packagesRoot);
  const workspaces = entries.map((entry) => {
    const directory = path.join(packagesRoot, entry.name);
    const packageJsonPath = path.join(directory, 'package.json');
    if (!fs.existsSync(packageJsonPath)) return null;
    const pkg = readPackageJson(packageJsonPath);
    if (typeof pkg.name !== 'string' || pkg.name.length === 0) {
      throw new Error(`Framework workspace is missing a package name: packages/${entry.name}`);
    }
    if (typeof pkg.scripts?.build !== 'string' || pkg.scripts.build.length === 0) return null;
    return { directory, directoryName: entry.name, pkg };
  }).filter(Boolean);

  const byName = new Map();
  for (const workspace of workspaces) {
    if (byName.has(workspace.pkg.name)) {
      throw new Error(`Duplicate Framework workspace package name: ${workspace.pkg.name}`);
    }
    byName.set(workspace.pkg.name, workspace);
  }
  const taskNameByPackage = new Map(
    workspaces.map((workspace) => [workspace.pkg.name, `workspace:${workspace.directoryName}`]),
  );
  const dependenciesFor = (workspace) => packageDependencyNames(workspace.pkg)
    .filter((name) => byName.has(name))
    .map((name) => taskNameByPackage.get(name));

  const sorted = topologicalSort(workspaces, dependenciesFor, taskNameByPackage);
  const outputByTask = new Map(sorted.map((workspace) => [
    taskNameByPackage.get(workspace.pkg.name),
    `packages/${workspace.directoryName}/dist`,
  ]));
  return sorted.map((workspace) => {
    const name = taskNameByPackage.get(workspace.pkg.name);
    const dependencies = dependenciesFor(workspace);
    return {
      name,
      kind: 'workspace',
      command: { file: 'npm', args: ['run', 'build', '-w', workspace.pkg.name] },
      inputs: uniqueSorted([
        ...existingRepositoryPaths(rootDir, ['package-lock.json', 'tsconfig.json']),
        ...workspaceInputs(rootDir, workspace.directory),
        ...dependencies.map((dependency) => outputByTask.get(dependency)),
      ]),
      outputs: [outputByTask.get(name)],
      dependencies,
    };
  });
}

function topologicalSort(workspaces, dependenciesFor, taskNameByPackage) {
  const byTask = new Map(workspaces.map((workspace) => [
    taskNameByPackage.get(workspace.pkg.name),
    workspace,
  ]));
  const remaining = new Map(workspaces.map((workspace) => [
    taskNameByPackage.get(workspace.pkg.name),
    new Set(dependenciesFor(workspace)),
  ]));
  const sorted = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([name]) => name)
      .sort();
    if (ready.length === 0) {
      throw new Error(`Framework workspace build dependency cycle: ${[...remaining.keys()].sort().join(', ')}`);
    }
    for (const name of ready) {
      sorted.push(byTask.get(name));
      remaining.delete(name);
      for (const dependencies of remaining.values()) dependencies.delete(name);
    }
  }
  return sorted;
}

function discoverRootPluginTasks(rootDir, workspaceTasks, pluginDiscovery) {
  const workspaceByPackage = workspacePackageTaskMap(rootDir, workspaceTasks);
  const pluginsRoot = path.join(rootDir, 'plugins');
  return pluginDiscovery.discoverAllPlugins(rootDir)
    .filter((pluginDir) => isPathWithin(pluginDir, pluginsRoot))
    .map((pluginDir) => createPluginTask(
      rootDir,
      pluginDir,
      workspaceByPackage,
      workspaceTasks,
      pluginDiscovery.discoverPlugin,
    ));
}

function createPluginTask(rootDir, pluginDir, workspaceByPackage, workspaceTasks, discoverPlugin) {
  const plugin = discoverPlugin(pluginDir);
  const repositoryPluginDir = toRepositoryPath(rootDir, plugin.rootDir);
  const workspaceDependencies = uniqueSorted(['@itharbors/kit-cli', ...packageDependencyNames(plugin.pkg)])
    .map((dependency) => workspaceByPackage.get(dependency))
    .filter(Boolean);
  return {
    name: `plugin:${repositoryPluginDir}`,
    kind: 'plugin',
    pluginDir: repositoryPluginDir,
    command: { file: 'node', args: ['scripts/ce-plugin.mjs', 'build', repositoryPluginDir] },
    inputs: uniqueSorted([
      ...existingRepositoryPaths(rootDir, [
        'package-lock.json',
        'tsconfig.json',
        'scripts/ce-plugin.mjs',
        'packages/kit-cli/dist',
      ]),
      ...pluginInputs(rootDir, plugin),
      ...workspaceDependencies.flatMap((dependency) => (
        workspaceTaskOutput(workspaceTasks, dependency)
      )),
    ]),
    outputs: pluginOutputs(rootDir, plugin),
    dependencies: workspaceDependencies,
  };
}

function createKitTask(rootDir, descriptor, workspaceTasks, pluginDiscovery) {
  const directory = descriptor.directory;
  const pluginDirectories = pluginDiscovery.discoverAllPlugins(directory).filter((pluginDir) => (
    isPathWithin(pluginDir, path.join(directory, 'plugins'))
  ));
  const plugins = pluginDirectories.map(pluginDiscovery.discoverPlugin);
  const workspaceByPackage = workspacePackageTaskMap(rootDir, workspaceTasks);
  const dependencyNames = new Set([
    '@itharbors/kit-cli',
    ...packageDependencyNames(descriptor.packageJson),
    ...plugins.flatMap((plugin) => packageDependencyNames(plugin.pkg)),
  ]);
  const dependencies = [...dependencyNames]
    .map((dependency) => workspaceByPackage.get(dependency))
    .filter(Boolean)
    .sort();
  const relativeDirectory = toRepositoryPath(rootDir, directory);
  const localWorkspaceOutputs = discoverLocalWorkspaceOutputs(rootDir, directory);
  const outputs = uniqueSorted([
    ...localWorkspaceOutputs,
    ...plugins.flatMap((plugin) => pluginOutputs(rootDir, plugin)),
  ]);
  if (outputs.length === 0) {
    throw new Error(`Kit ${descriptor.slug} declares no build output`);
  }
  return {
    name: `kit:${descriptor.slug}`,
    kind: 'kit',
    kitSlug: descriptor.slug,
    kitDir: relativeDirectory,
    command: {
      file: 'node',
      args: ['packages/kit-cli/dist/cli.js', 'build', relativeDirectory],
    },
    inputs: uniqueSorted([
      ...existingRepositoryPaths(rootDir, ['package-lock.json', 'tsconfig.json', 'packages/kit-cli/dist']),
      ...collectKitSourceInputs(rootDir, directory),
      ...dependencies.flatMap((dependency) => workspaceTaskOutput(workspaceTasks, dependency)),
    ]),
    outputs,
    dependencies,
  };
}

function workspacePackageTaskMap(rootDir, workspaceTasks) {
  return new Map(workspaceTasks.map((task) => {
    const packageJson = readPackageJson(path.join(rootDir, task.outputs[0], '..', 'package.json'));
    return [packageJson.name, task.name];
  }));
}

function workspaceTaskOutput(workspaceTasks, taskName) {
  return workspaceTasks.find((task) => task.name === taskName)?.outputs ?? [];
}

function workspaceInputs(rootDir, directory) {
  const inputs = [toRepositoryPath(rootDir, path.join(directory, 'package.json'))];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    if (entry.isDirectory() && entry.name === 'src') inputs.push(toRepositoryPath(rootDir, path.join(directory, entry.name)));
    if (entry.isFile() && (entry.name.endsWith('.json') || entry.name.endsWith('.ts') || entry.name.endsWith('.html'))) {
      inputs.push(toRepositoryPath(rootDir, path.join(directory, entry.name)));
    }
  }
  return inputs;
}

function pluginInputs(rootDir, plugin) {
  return [
    toRepositoryPath(rootDir, plugin.packageJsonPath),
    ...existingAbsolutePaths(rootDir, [plugin.tsconfigPath]),
    ...(plugin.main ? [toRepositoryPath(rootDir, plugin.main.sourceDir)] : []),
    ...plugin.panels.map((panel) => toRepositoryPath(rootDir, panel.sourceDir)),
  ];
}

function pluginOutputs(rootDir, plugin) {
  return [
    ...(plugin.main ? [toRepositoryPath(rootDir, plugin.main.distDir)] : []),
    ...plugin.panels.map((panel) => toRepositoryPath(rootDir, panel.distDir)),
  ];
}

function discoverLocalWorkspaceOutputs(rootDir, kitDirectory) {
  const packageJson = readPackageJson(path.join(kitDirectory, 'package.json'));
  const patterns = Array.isArray(packageJson.workspaces) ? packageJson.workspaces : [];
  const outputs = [];
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || !pattern.endsWith('/*')) continue;
    const workspaceRoot = path.join(kitDirectory, pattern.slice(0, -2));
    for (const entry of readDirectories(workspaceRoot)) {
      const workspaceDirectory = path.join(workspaceRoot, entry.name);
      const manifestPath = path.join(workspaceDirectory, 'package.json');
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = readPackageJson(manifestPath);
      if (typeof manifest.scripts?.build === 'string') {
        outputs.push(toRepositoryPath(rootDir, path.join(workspaceDirectory, 'dist')));
      }
    }
  }
  return outputs;
}

function collectKitSourceInputs(rootDir, kitDirectory) {
  const inputs = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && ['dist', 'node_modules', 'coverage', '.vite', '.vitest'].includes(entry.name)) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile()) inputs.push(toRepositoryPath(rootDir, entryPath));
    }
  };
  visit(kitDirectory);
  return inputs;
}

function packageDependencyNames(pkg) {
  return uniqueSorted(Object.keys({
    ...(pkg.dependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  }));
}

function readDirectories(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function readPackageJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function existingRepositoryPaths(rootDir, candidates) {
  return candidates.filter((candidate) => fs.existsSync(path.join(rootDir, candidate)));
}

function existingAbsolutePaths(rootDir, candidates) {
  return candidates.filter((candidate) => fs.existsSync(candidate)).map((candidate) => toRepositoryPath(rootDir, candidate));
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function isPathWithin(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
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
