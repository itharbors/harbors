import {
  lstat,
  readFile,
  readdir,
  realpath,
  stat,
} from 'node:fs/promises';
import path from 'node:path';

import {
  normalizeArchivePath,
  parseKitPackageManifest,
  type KitPackageManifest,
} from '@itharbors/kit-core';

export interface PayloadFile {
  absolutePath: string;
  archivePath: string;
  size: number;
}

export interface ValidatedKitProject {
  directory: string;
  manifest: KitPackageManifest;
  runtimeManifest: Record<string, unknown>;
  payload: PayloadFile[];
  packageNames: string[];
}

interface PluginProject {
  directory: string;
  archiveDirectory: string;
  manifest: Record<string, any>;
  name: string;
}

interface InstalledPackage {
  directory: string;
  manifest: Record<string, any>;
  name: string;
  version: string;
  workspace: boolean;
}

interface DependencyRequest {
  importer: string;
  name: string;
  optional: boolean;
}

const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;

function objectValue(value: unknown, context: string): Record<string, any> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, any>;
}

function nonEmptyString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
  return value;
}

async function readJson(file: string, context: string): Promise<Record<string, any>> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`${context} is not valid JSON: ${(error as Error).message}`);
  }
  return objectValue(value, context);
}

function assertInside(root: string, candidate: string, context: string): void {
  const relative = path.relative(root, candidate);
  if (relative === '' || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error(`${context} must stay inside ${root}`);
  }
}

function readPluginList(value: unknown, context: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be an array`);
  }
  const plugins = value.map((item, index) => nonEmptyString(item, `${context}[${index}]`));
  if (new Set(plugins).size !== plugins.length) {
    throw new Error(`${context} must not contain duplicates`);
  }
  return plugins;
}

async function assertRegularFile(file: string, context: string): Promise<void> {
  let info;
  try {
    info = await lstat(file);
  } catch {
    throw new Error(`${context} file does not exist`);
  }
  if (info.isSymbolicLink()) {
    throw new Error(`${context} must not be a symbolic link`);
  }
  if (!info.isFile()) {
    throw new Error(`${context} must be a regular file`);
  }
}

async function containsPackageJson(directory: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.name === 'package.json' && entry.isFile()) return true;
    if (entry.isDirectory() && await containsPackageJson(path.join(directory, entry.name))) return true;
  }
  return false;
}

async function discoverPlugins(kitDirectory: string): Promise<PluginProject[]> {
  const pluginsDirectory = path.join(kitDirectory, 'plugins');
  let entries;
  try {
    entries = await readdir(pluginsDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const plugins: PluginProject[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const directory = path.join(pluginsDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Plugin ${entry.name} must not be a symbolic link`);
    }
    if (!entry.isDirectory()) continue;
    const packageFile = path.join(directory, 'package.json');
    try {
      await assertRegularFile(packageFile, `Plugin ${entry.name} package.json`);
    } catch (error) {
      if (await containsPackageJson(directory)) {
        throw new Error(`Plugin manifests must be placed in one-level plugins/* directories`);
      }
      if ((error as Error).message.endsWith('file does not exist')) continue;
      throw error;
    }
    const manifest = await readJson(packageFile, `Plugin ${entry.name} package.json`);
    plugins.push({
      directory,
      archiveDirectory: `plugins/${entry.name}`,
      manifest,
      name: nonEmptyString(manifest.name, `Plugin ${entry.name} name`),
    });
  }
  return plugins;
}

async function collectDirectory(
  directory: string,
  archiveDirectory: string,
  append: (absolutePath: string, archivePath: string) => Promise<void>,
): Promise<void> {
  const directoryInfo = await lstat(directory);
  if (directoryInfo.isSymbolicLink()) {
    throw new Error(`Selected payload path ${directory} must not be a symbolic link`);
  }
  if (!directoryInfo.isDirectory()) {
    throw new Error(`Selected payload path ${directory} must be a directory`);
  }
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = path.join(directory, entry.name);
    const archivePath = path.posix.join(archiveDirectory, entry.name);
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink()) {
      throw new Error(`Selected payload path ${archivePath} must not be a symbolic link`);
    }
    if (info.isDirectory()) {
      await collectDirectory(absolutePath, archivePath, append);
    } else if (info.isFile()) {
      await append(absolutePath, archivePath);
    } else {
      throw new Error(`Selected payload path ${archivePath} must be a regular file`);
    }
  }
}

async function collectInstalledPackageDirectory(
  directory: string,
  archiveDirectory: string,
  append: (absolutePath: string, archivePath: string) => Promise<void>,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === 'node_modules') continue;
    const absolutePath = path.join(directory, entry.name);
    const archivePath = path.posix.join(archiveDirectory, entry.name);
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink()) {
      throw new Error(`Production dependency payload ${archivePath} must not be a symbolic link`);
    }
    if (info.isDirectory()) {
      await collectInstalledPackageDirectory(absolutePath, archivePath, append);
    } else if (info.isFile()) {
      await append(absolutePath, archivePath);
    } else {
      throw new Error(`Production dependency payload ${archivePath} must be a regular file`);
    }
  }
}

function dependencyRequests(
  manifest: Record<string, any>,
  importer: string,
): DependencyRequest[] {
  const dependencies = objectValue(manifest.dependencies ?? {}, 'package dependencies');
  const optionalDependencies = objectValue(
    manifest.optionalDependencies ?? {},
    'package optionalDependencies',
  );
  const peerDependencies = objectValue(manifest.peerDependencies ?? {}, 'package peerDependencies');
  const peerMetadata = objectValue(manifest.peerDependenciesMeta ?? {}, 'package peerDependenciesMeta');
  const names = new Set([
    ...Object.keys(dependencies),
    ...Object.keys(optionalDependencies),
    ...Object.keys(peerDependencies),
  ]);
  return [...names].sort().map((name) => {
    if (!PACKAGE_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid production dependency name: ${name}`);
    }
    const peerOptions = peerMetadata[name];
    return {
      importer,
      name,
      optional: Object.hasOwn(optionalDependencies, name)
        || (peerOptions !== null
          && typeof peerOptions === 'object'
          && !Array.isArray(peerOptions)
          && peerOptions.optional === true),
    };
  });
}

async function findInstalledPackage(
  installationRoot: string,
  importer: string,
  name: string,
): Promise<InstalledPackage | null> {
  const segments = name.split('/');
  let current = importer;
  while (true) {
    const candidate = path.join(current, 'node_modules', ...segments);
    const info = await lstat(candidate).catch(() => null);
    if (info) {
      if (!info.isDirectory() && !info.isSymbolicLink()) {
        throw new Error(`Installed production dependency ${name} is not a directory`);
      }
      const directory = await realpath(candidate);
      assertInside(installationRoot, directory, `Production dependency ${name}`);
      const manifest = await readJson(
        path.join(directory, 'package.json'),
        `Production dependency ${name} package.json`,
      );
      const installedName = nonEmptyString(manifest.name, `Production dependency ${name} name`);
      if (installedName !== name) {
        throw new Error(`Production dependency ${name} resolved to package ${installedName}`);
      }
      return {
        directory,
        manifest,
        name,
        version: nonEmptyString(manifest.version, `Production dependency ${name} version`),
        workspace: await isWorkspaceDependency(
          installationRoot,
          candidate,
          directory,
          info.isSymbolicLink(),
        ),
      };
    }
    if (current === installationRoot) break;
    const parent = path.dirname(current);
    const relative = path.relative(installationRoot, parent);
    if (parent === current || relative === '..' || relative.startsWith(`..${path.sep}`)) break;
    current = parent;
  }
  return null;
}

async function isWorkspaceDependency(
  installationRoot: string,
  candidate: string,
  directory: string,
  symbolicLink: boolean,
): Promise<boolean> {
  if (!symbolicLink) return false;
  const relativeCandidate = path.relative(installationRoot, candidate).split(path.sep).join('/');
  if (!relativeCandidate.startsWith('node_modules/')) return false;
  const packageLock = await readJson(
    path.join(installationRoot, 'package-lock.json'),
    'package-lock.json',
  ).catch(() => null);
  const packages = packageLock?.packages;
  if (packages === null || typeof packages !== 'object' || Array.isArray(packages)) return false;
  const packageEntry = packages[relativeCandidate];
  if (packageEntry === null || typeof packageEntry !== 'object' || Array.isArray(packageEntry)
    || packageEntry.link !== true || typeof packageEntry.resolved !== 'string') {
    return false;
  }
  const resolved = await realpath(path.resolve(installationRoot, packageEntry.resolved)).catch(() => null);
  return resolved === directory;
}

async function findDependencyInstallationRoot(
  kitDirectory: string,
  runtimeManifest: Record<string, any>,
): Promise<string> {
  const name = nonEmptyString(runtimeManifest.name, 'package.json name');
  const version = nonEmptyString(runtimeManifest.version, 'package.json version');
  let current = kitDirectory;
  while (true) {
    const packageLock = await readJson(
      path.join(current, 'package-lock.json'),
      'package-lock.json',
    ).catch(() => null);
    const packages = packageLock?.packages;
    const relativeKitPath = path.relative(current, kitDirectory).split(path.sep).join('/');
    if (packages !== null && typeof packages === 'object' && !Array.isArray(packages)) {
      const packageEntry = packages[relativeKitPath];
      if (packageEntry !== null && typeof packageEntry === 'object' && !Array.isArray(packageEntry)
        && packageEntry.name === name && packageEntry.version === version) {
        return current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return kitDirectory;
}

async function collectProductionDependencies(
  kitDirectory: string,
  installationRoot: string,
  runtimeManifest: Record<string, any>,
  plugins: PluginProject[],
  append: (absolutePath: string, archivePath: string) => Promise<void>,
): Promise<string[]> {
  const pending = [
    ...dependencyRequests(runtimeManifest, kitDirectory),
    ...plugins.flatMap((plugin) => dependencyRequests(plugin.manifest, plugin.directory)),
  ];
  const versions = new Map<string, string>();
  const packageNames = new Set<string>();

  while (pending.length > 0) {
    const request = pending.shift()!;
    const installed = await findInstalledPackage(
      installationRoot,
      request.importer,
      request.name,
    );
    if (!installed) {
      if (request.optional) continue;
      throw new Error(`Production dependency ${request.name} is not installed`);
    }
    const observedVersion = versions.get(installed.name);
    if (observedVersion !== undefined) {
      if (observedVersion !== installed.version) {
        throw new Error(
          `Production dependency ${installed.name} resolves to conflicting versions ${observedVersion} and ${installed.version}`,
        );
      }
      continue;
    }
    versions.set(installed.name, installed.version);
    packageNames.add(installed.name);

    const archiveDirectory = `node_modules/${installed.name}`;
    if (installed.workspace) {
      await append(
        path.join(installed.directory, 'package.json'),
        `${archiveDirectory}/package.json`,
      );
      await collectDirectory(
        path.join(installed.directory, 'dist'),
        `${archiveDirectory}/dist`,
        append,
      );
    } else {
      await collectInstalledPackageDirectory(installed.directory, archiveDirectory, append);
    }
    pending.push(...dependencyRequests(installed.manifest, installed.directory));
  }
  return [...packageNames];
}

function isDistJavaScriptEntry(value: string): boolean {
  return /(^|\/)dist\/.+\.(m?js|cjs)$/u.test(value);
}

function isDistPanelEntry(value: string): boolean {
  return /(^|\/)dist\/index\.html$/u.test(value);
}

export async function validateKit(directory: string): Promise<ValidatedKitProject> {
  const resolvedDirectory = path.resolve(directory);
  const kitDirectory = await realpath(resolvedDirectory);
  const kitInfo = await stat(kitDirectory);
  if (!kitInfo.isDirectory()) {
    throw new Error(`Kit directory is not a directory: ${directory}`);
  }

  const kitJsonPath = path.join(kitDirectory, 'kit.json');
  const packageJsonPath = path.join(kitDirectory, 'package.json');
  const manifest = parseKitPackageManifest(await readJson(kitJsonPath, 'kit.json'));
  const runtimeManifest = await readJson(packageJsonPath, 'package.json');
  if (runtimeManifest.name !== manifest.id) {
    throw new Error(`package.json name must match Kit id ${manifest.id}`);
  }
  if (runtimeManifest.version !== manifest.version) {
    throw new Error(`package.json version must match Kit version ${manifest.version}`);
  }

  const kit = objectValue(objectValue(runtimeManifest['ce-editor'], 'ce-editor').kit, 'ce-editor.kit');
  const menuRoot = objectValue(kit.menuRoot, 'menuRoot');
  nonEmptyString(menuRoot.id, 'menuRoot.id');
  nonEmptyString(menuRoot.label, 'menuRoot.label');
  const layouts = objectValue(kit.layouts, 'layouts');
  const defaultLayout = nonEmptyString(layouts.default, 'layouts.default');
  const windowEntries = objectValue(kit.windowEntries, 'windowEntries');
  const mainWindow = nonEmptyString(windowEntries.main, 'windowEntries.main');
  const secondaryWindow = nonEmptyString(windowEntries.secondary, 'windowEntries.secondary');
  const ordinaryPlugins = readPluginList(kit.plugin, 'plugin');
  const startup = kit.startup === undefined ? {} : objectValue(kit.startup, 'startup');
  const startupPlugins = readPluginList(startup.plugins, 'startup.plugins');
  const ordinarySet = new Set(ordinaryPlugins);
  const overlap = startupPlugins.find((name) => ordinarySet.has(name));
  if (overlap) {
    throw new Error(`startup plugin ${overlap} must not also be an ordinary plugin`);
  }
  if (startupPlugins.length > 0 && !manifest.permissions.includes('application-startup')) {
    throw new Error('Kits with startup.plugins require the application-startup permission');
  }
  const declaredPlugins = [...ordinaryPlugins, ...startupPlugins];

  const plugins = await discoverPlugins(kitDirectory);
  const names = plugins.map((plugin) => plugin.name);
  if (new Set(names).size !== names.length) {
    throw new Error('Kit contains a duplicate plugin package name');
  }
  const declaredSet = new Set(declaredPlugins);
  const undeclared = plugins.find((plugin) => !declaredSet.has(plugin.name));
  if (undeclared) {
    throw new Error(`Kit contains undeclared plugin ${undeclared.name}`);
  }
  const discoveredSet = new Set(names);
  const missing = declaredPlugins.find((name) => !discoveredSet.has(name));
  if (missing) {
    throw new Error(`Declared plugin ${missing} does not exist in a one-level plugins/* directory`);
  }

  const payloadByPath = new Map<string, PayloadFile>();
  const caseFoldedPaths = new Set<string>();
  const append = async (absolutePath: string, archivePathInput: string): Promise<void> => {
    const archivePath = normalizeArchivePath(archivePathInput.split(path.sep).join('/'));
    await assertRegularFile(absolutePath, `Payload ${archivePath}`);
    if (payloadByPath.has(archivePath)) {
      throw new Error(`Duplicate payload path ${archivePath}`);
    }
    const folded = archivePath.toLocaleLowerCase('en-US');
    if (caseFoldedPaths.has(folded)) {
      throw new Error(`Case-folded duplicate payload path ${archivePath}`);
    }
    caseFoldedPaths.add(folded);
    const info = await stat(absolutePath);
    payloadByPath.set(archivePath, { absolutePath, archivePath, size: info.size });
  };

  await append(kitJsonPath, 'kit.json');
  await append(packageJsonPath, 'package.json');
  for (const [value, context] of [
    [defaultLayout, 'layouts.default'],
    [mainWindow, 'windowEntries.main'],
    [secondaryWindow, 'windowEntries.secondary'],
  ] as const) {
    const absolutePath = path.resolve(kitDirectory, value);
    assertInside(kitDirectory, absolutePath, context);
    await assertRegularFile(absolutePath, context);
    await append(absolutePath, value);
  }

  for (const plugin of plugins) {
    await append(
      path.join(plugin.directory, 'package.json'),
      `${plugin.archiveDirectory}/package.json`,
    );
    const mainEntry = nonEmptyString(plugin.manifest.main, `Plugin ${plugin.name} main`);
    if (!isDistJavaScriptEntry(mainEntry)) {
      throw new Error(`Plugin ${plugin.name} main must point to a dist JavaScript entry`);
    }
    const mainFile = path.resolve(plugin.directory, mainEntry);
    assertInside(plugin.directory, mainFile, `Plugin ${plugin.name} main`);
    await assertRegularFile(mainFile, `Plugin ${plugin.name} main`);
    const mainDist = path.dirname(mainFile);
    await collectDirectory(
      mainDist,
      path.posix.dirname(`${plugin.archiveDirectory}/${mainEntry.replace(/^\.\//u, '')}`),
      append,
    );

    const ceEditor = objectValue(plugin.manifest['ce-editor'], `Plugin ${plugin.name} ce-editor`);
    const contribute = ceEditor.contribute === undefined
      ? {}
      : objectValue(ceEditor.contribute, `Plugin ${plugin.name} contribute`);
    const panels = contribute.panel === undefined
      ? {}
      : objectValue(contribute.panel, `Plugin ${plugin.name} panels`);
    for (const [panelName, rawDefinition] of Object.entries(panels)) {
      const definition = objectValue(rawDefinition, `Plugin ${plugin.name} panel ${panelName}`);
      const panelEntry = nonEmptyString(
        definition.entry,
        `Plugin ${plugin.name} panel ${panelName} entry`,
      );
      if (!isDistPanelEntry(panelEntry)) {
        throw new Error(`Plugin ${plugin.name} panel ${panelName} entry must point to a dist index.html file`);
      }
      const panelFile = path.resolve(plugin.directory, panelEntry);
      assertInside(plugin.directory, panelFile, `Plugin ${plugin.name} panel ${panelName} entry`);
      await assertRegularFile(panelFile, `Plugin ${plugin.name} panel ${panelName} entry`);
      await collectDirectory(
        path.dirname(panelFile),
        path.posix.dirname(`${plugin.archiveDirectory}/${panelEntry.replace(/^\.\//u, '')}`),
        append,
      );
    }

    const assets = ceEditor.assets === undefined
      ? {}
      : objectValue(ceEditor.assets, `Plugin ${plugin.name} assets`);
    if (assets.public !== undefined && !Array.isArray(assets.public)) {
      throw new Error(`Plugin ${plugin.name} public assets must be an array`);
    }
    for (const [index, rawPublicRoot] of (assets.public ?? []).entries()) {
      const publicRoot = nonEmptyString(
        rawPublicRoot,
        `Plugin ${plugin.name} public asset root ${index}`,
      );
      const publicDirectory = path.resolve(plugin.directory, publicRoot);
      assertInside(plugin.directory, publicDirectory, `Plugin ${plugin.name} public asset root`);
      const publicInfo = await lstat(publicDirectory);
      if (publicInfo.isSymbolicLink()) {
        throw new Error(`Plugin ${plugin.name} public asset root must not be a symbolic link`);
      }
      const realPublicDirectory = await realpath(publicDirectory);
      assertInside(plugin.directory, realPublicDirectory, `Plugin ${plugin.name} public asset root`);
      await collectDirectory(
        publicDirectory,
        `${plugin.archiveDirectory}/${path.relative(plugin.directory, publicDirectory).split(path.sep).join('/')}`,
        append,
      );
    }
  }

  const dependencyInstallationRoot = await findDependencyInstallationRoot(
    kitDirectory,
    runtimeManifest,
  );
  const dependencyPackageNames = await collectProductionDependencies(
    kitDirectory,
    dependencyInstallationRoot,
    runtimeManifest,
    plugins,
    append,
  );

  const payload = [...payloadByPath.values()].sort(
    (left, right) => left.archivePath.localeCompare(right.archivePath),
  );
  return {
    directory: kitDirectory,
    manifest,
    runtimeManifest,
    payload,
    packageNames: [manifest.id, ...names, ...dependencyPackageNames]
      .sort((left, right) => left.localeCompare(right)),
  };
}
