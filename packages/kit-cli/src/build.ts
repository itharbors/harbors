import { spawn } from 'node:child_process';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import {
  parseKitPackageManifest,
  parseRepositoryKitPackage,
  type KitPackageManifest,
  type RepositoryKitPackageMetadata,
} from '@itharbors/kit-core';

import { buildPlugin, discoverPlugin } from './plugin-build/index.js';

type JsonRecord = Record<string, unknown>;

export type KitCommand = 'npm' | 'plugin-build';

export interface KitCommandRunner {
  run(command: KitCommand, args: readonly string[], cwd: string): Promise<void> | void;
}

export interface BuildKitOptions {
  directory: string;
  commandRunner?: KitCommandRunner;
}

export interface TestKitOptions {
  directory: string;
  commandRunner?: KitCommandRunner;
}

export interface BuildKitResult {
  directory: string;
  id: string;
  version: string;
  plugins: string[];
}

export interface TestKitResult {
  directory: string;
  id: string;
  version: string;
  script: string;
}

interface KitProject {
  directory: string;
  manifest: KitPackageManifest;
  metadata: RepositoryKitPackageMetadata;
  packageJson: JsonRecord;
  plugins: string[];
  hasWorkspaces: boolean;
}

function record(value: unknown, context: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as JsonRecord;
}

function nonEmptyString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
  return value;
}

async function assertDirectory(directory: string, context: string): Promise<void> {
  let info;
  try {
    info = await lstat(directory);
  } catch {
    throw new Error(`${context} does not exist: ${directory}`);
  }
  if (info.isSymbolicLink()) throw new Error(`${context} must not be a symbolic link`);
  if (!info.isDirectory()) throw new Error(`${context} must be a directory: ${directory}`);
}

async function assertRegularFile(file: string, context: string): Promise<void> {
  let info;
  try {
    info = await lstat(file);
  } catch {
    throw new Error(`${context} does not exist: ${file}`);
  }
  if (info.isSymbolicLink()) throw new Error(`${context} must not be a symbolic link`);
  if (!info.isFile()) throw new Error(`${context} must be a regular file: ${file}`);
}

function resolveInsideKit(root: string, candidate: string, context: string): string {
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${context} must stay inside the Kit directory`);
  }
  return resolved;
}

async function readJson(file: string, context: string): Promise<JsonRecord> {
  await assertRegularFile(file, context);
  const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
  return record(parsed, context);
}

function declaredPlugins(packageJson: JsonRecord): string[] {
  const ceEditor = record(packageJson['ce-editor'], 'package.json ce-editor');
  const kit = record(ceEditor.kit, 'package.json ce-editor.kit');
  const ordinary = pluginNames(kit.plugin, 'package.json ce-editor.kit.plugin');
  const startup = kit.startup === undefined ? undefined : record(
    kit.startup,
    'package.json ce-editor.kit.startup',
  );
  const startupPlugins = startup === undefined
    ? []
    : pluginNames(startup.plugins, 'package.json ce-editor.kit.startup.plugins');
  const all = [...ordinary, ...startupPlugins];
  if (new Set(all).size !== all.length) {
    throw new Error('package.json ce-editor.kit declares duplicate plugins');
  }
  return all;
}

function pluginNames(value: unknown, context: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  const names = value.map((item, index) => nonEmptyString(item, `${context}[${index}]`));
  if (new Set(names).size !== names.length) throw new Error(`${context} must not contain duplicates`);
  return names;
}

async function discoverDeclaredPluginDirectories(root: string, packageJson: JsonRecord): Promise<string[]> {
  const declared = declaredPlugins(packageJson);
  const declaredSet = new Set(declared);
  const pluginsRoot = resolveInsideKit(root, 'plugins', 'Kit plugins directory');
  const pluginsRootInfo = await lstat(pluginsRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (pluginsRootInfo === null) {
    if (declared.length === 0) return [];
    throw new Error(`Kit is missing declared plugin ${declared[0]}`);
  }
  if (pluginsRootInfo.isSymbolicLink()) {
    throw new Error('Kit plugins directory must not be a symbolic link');
  }
  if (!pluginsRootInfo.isDirectory()) throw new Error('Kit plugins directory must be a directory');
  const entries = await readdir(pluginsRoot, { withFileTypes: true });

  const byPackageName = new Map<string, string>();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const pluginDirectory = resolveInsideKit(root, path.join('plugins', entry.name), 'Plugin directory');
    if (entry.isSymbolicLink()) throw new Error(`Plugin directory must not be a symbolic link: ${pluginDirectory}`);
    if (!entry.isDirectory()) continue;
    const packageJsonPath = resolveInsideKit(
      root,
      path.join('plugins', entry.name, 'package.json'),
      'Plugin package.json',
    );
    const pluginPackage = await readJson(packageJsonPath, `Plugin ${entry.name} package.json`);
    const name = nonEmptyString(pluginPackage.name, `Plugin ${entry.name} package.json name`);
    if (byPackageName.has(name)) throw new Error(`Kit has duplicate plugin package name ${name}`);
    byPackageName.set(name, pluginDirectory);
  }
  for (const [name] of byPackageName) {
    if (!declaredSet.has(name)) throw new Error(`Kit has undeclared plugin ${name}`);
  }
  return declared.map((name) => {
    const directory = byPackageName.get(name);
    if (!directory) throw new Error(`Kit is missing declared plugin ${name}`);
    return directory;
  });
}

async function loadKitProject(directory: string): Promise<KitProject> {
  if (typeof directory !== 'string' || directory.trim().length === 0) {
    throw new Error('Expected <kit-directory>');
  }
  const suppliedDirectory = path.resolve(directory);
  await assertDirectory(suppliedDirectory, 'Kit directory');
  const root = await realpath(suppliedDirectory);
  await assertDirectory(root, 'Kit directory');

  const packageJson = await readJson(
    resolveInsideKit(root, 'package.json', 'Kit package.json'),
    'Kit package.json',
  );
  const manifest = parseKitPackageManifest(await readJson(
    resolveInsideKit(root, 'kit.json', 'Kit manifest'),
    'Kit manifest',
  ));
  const metadata = parseRepositoryKitPackage(packageJson['harbors']);
  if (nonEmptyString(packageJson.name, 'Kit package.json name') !== manifest.id) {
    throw new Error('Kit package.json name must match kit.json id');
  }
  if (nonEmptyString(packageJson.version, 'Kit package.json version') !== manifest.version) {
    throw new Error('Kit package.json version must match kit.json version');
  }
  const plugins = await discoverDeclaredPluginDirectories(root, packageJson);
  const workspaces = packageJson.workspaces;
  if (workspaces !== undefined && (
    !Array.isArray(workspaces)
    || workspaces.some((item) => typeof item !== 'string' || item.trim().length === 0)
  )) {
    throw new Error('Kit package.json workspaces must be an array of non-empty strings');
  }
  return {
    directory: root,
    manifest,
    metadata,
    packageJson,
    plugins,
    hasWorkspaces: Array.isArray(workspaces) && workspaces.length > 0,
  };
}

const productionRunner: KitCommandRunner = {
  async run(command, args, cwd): Promise<void> {
    if (command === 'plugin-build') {
      if (args.length !== 1) throw new Error('plugin-build requires exactly one plugin directory');
      buildPlugin(discoverPlugin(args[0]));
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn('npm', ['--prefix', cwd, ...args], { cwd, stdio: 'inherit' });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`npm command failed${signal ? ` with signal ${signal}` : ` with exit code ${String(code)}`}`));
      });
    });
  },
};

export async function buildKit(options: BuildKitOptions): Promise<BuildKitResult> {
  const project = await loadKitProject(options.directory);
  const runner = options.commandRunner ?? productionRunner;
  await runner.run('npm', ['run', 'build:prepare', '--if-present'], project.directory);
  if (project.hasWorkspaces) {
    await runner.run('npm', ['run', 'build', '--workspaces', '--if-present'], project.directory);
  }
  for (const pluginDirectory of project.plugins) {
    await runner.run('plugin-build', [pluginDirectory], project.directory);
  }
  return {
    directory: project.directory,
    id: project.manifest.id,
    version: project.manifest.version,
    plugins: [...project.plugins],
  };
}

export async function testKit(options: TestKitOptions): Promise<TestKitResult> {
  const project = await loadKitProject(options.directory);
  const scripts = project.packageJson.scripts === undefined
    ? {}
    : record(project.packageJson.scripts, 'Kit package.json scripts');
  const script = project.metadata.scripts.test;
  if (typeof scripts[script] !== 'string' || scripts[script].trim().length === 0) {
    throw new Error(`Descriptor test script ${script} must exist in package.json scripts`);
  }
  const runner = options.commandRunner ?? productionRunner;
  await runner.run('npm', ['run', script], project.directory);
  return {
    directory: project.directory,
    id: project.manifest.id,
    version: project.manifest.version,
    script,
  };
}
