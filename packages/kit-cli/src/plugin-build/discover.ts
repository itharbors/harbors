import fs from 'node:fs';
import path from 'node:path';

import { readJsonFile, resolveInsidePlugin, resolvePluginDir } from './fs.js';
import type { PluginMain, PluginPanel, PluginProject } from './types.js';

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export interface RuntimeKitDescriptor {
  slug: string;
  directory: string;
  id: string;
  distribution: 'builtin' | 'market';
  isDefault: boolean;
  menuRoot: Readonly<{ id: string; label: string }>;
  packageJson: Record<string, unknown>;
}

function builtinDescriptors(descriptors: readonly RuntimeKitDescriptor[]): RuntimeKitDescriptor[] {
  if (!Array.isArray(descriptors)) throw new TypeError('Kit descriptors must be an array');
  const builtin = descriptors.filter((descriptor) => descriptor?.distribution === 'builtin');
  const ids = new Set<string>();
  const menuRoots = new Set<string>();
  for (const descriptor of builtin) {
    if (typeof descriptor.slug !== 'string' || typeof descriptor.id !== 'string') {
      throw new Error('Builtin Kit descriptor must contain slug and id');
    }
    const menuRootId = descriptor.menuRoot?.id;
    if (typeof menuRootId !== 'string' || menuRootId.length === 0) {
      throw new Error(`Builtin Kit descriptor ${descriptor.slug} must contain a menu root id`);
    }
    if (ids.has(descriptor.id)) throw new Error(`Duplicate builtin Kit id: ${descriptor.id}`);
    if (menuRoots.has(menuRootId)) throw new Error(`Duplicate builtin Kit menu root: ${menuRootId}`);
    ids.add(descriptor.id);
    menuRoots.add(menuRootId);
  }
  return [...builtin].sort((left, right) => left.slug.localeCompare(right.slug));
}

function appendPluginDirs(results: string[], pluginsRoot: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(pluginsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Plugin directory must not be a symbolic link: ${path.join(pluginsRoot, entry.name)}`);
    }
    if (!entry.isDirectory()) continue;
    const pluginDir = path.join(pluginsRoot, entry.name);
    if (fs.existsSync(path.join(pluginDir, 'package.json'))) results.push(pluginDir);
  }
}

function requirePluginNames(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)
    || value.some((item) => typeof item !== 'string' || item.trim().length === 0)
    || new Set(value).size !== value.length) {
    throw new Error(`${label} must contain unique non-empty plugin names`);
  }
  return [...value];
}

function discoverDeclaredKitPluginDirs(rootDir: string, descriptor: RuntimeKitDescriptor): string[] {
  const { slug: kitSlug, directory: kitRoot } = descriptor;
  if (typeof kitSlug !== 'string'
    || kitSlug.trim().length === 0
    || kitSlug === '.'
    || kitSlug === '..'
    || path.isAbsolute(kitSlug)
    || path.basename(kitSlug) !== kitSlug) {
    throw new Error('Builtin Kit slug must be a non-empty directory name');
  }
  if (typeof kitRoot !== 'string' || !path.isAbsolute(kitRoot)) {
    throw new Error(`Builtin Kit descriptor ${kitSlug} must contain an absolute directory`);
  }
  const expectedDirectory = path.join(rootDir, 'kits', kitSlug);
  let expectedInfo: fs.Stats;
  let providedInfo: fs.Stats;
  let expectedCanonical: string;
  let providedCanonical: string;
  try {
    expectedInfo = fs.lstatSync(expectedDirectory);
    providedInfo = fs.lstatSync(kitRoot);
    expectedCanonical = fs.realpathSync(expectedDirectory);
    providedCanonical = fs.realpathSync(kitRoot);
  } catch (error) {
    throw new Error(`Builtin Kit descriptor ${kitSlug} directory is invalid: ${(error as Error).message}`);
  }
  if (path.resolve(kitRoot) !== expectedDirectory
    || expectedInfo.isSymbolicLink() || !expectedInfo.isDirectory()
    || providedInfo.isSymbolicLink() || !providedInfo.isDirectory()
    || providedCanonical !== expectedCanonical) {
    throw new Error(`Builtin Kit descriptor ${kitSlug} directory must equal its canonical repository directory`);
  }
  const manifestPath = path.join(kitRoot, 'package.json');
  let manifest: Record<string, unknown>;
  try {
    manifest = readJsonFile(manifestPath);
  } catch (error) {
    throw new Error(`Invalid builtin Kit ${kitSlug} package.json: ${(error as Error).message}`);
  }
  const ceEditor = objectValue(manifest['ce-editor']);
  const declaration = objectValue(ceEditor?.kit);
  if (!declaration) throw new Error(`Builtin Kit ${kitSlug} must declare ce-editor.kit`);
  const ordinary = requirePluginNames(declaration.plugin, `Builtin Kit ${kitSlug} plugin`);
  const startup = declaration.startup === undefined ? null : objectValue(declaration.startup);
  if (declaration.startup !== undefined && !startup) {
    throw new Error(`Builtin Kit ${kitSlug} startup must be an object`);
  }
  const startupPlugins = requirePluginNames(startup?.plugins, `Builtin Kit ${kitSlug} startup.plugins`);
  const ordinarySet = new Set(ordinary);
  const overlap = startupPlugins.find((name) => ordinarySet.has(name));
  if (overlap) throw new Error(`Builtin Kit ${kitSlug} declares ${overlap} as ordinary and startup plugin`);

  const declaredNames = [...ordinary, ...startupPlugins];
  const declared = new Set(declaredNames);
  const pluginsRoot = path.join(kitRoot, 'plugins');
  let pluginDirectories: fs.Dirent[] = [];
  try {
    pluginDirectories = fs.readdirSync(pluginsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const byName = new Map<string, string>();
  for (const entry of pluginDirectories.sort((left, right) => left.name.localeCompare(right.name))) {
    const pluginDir = path.join(pluginsRoot, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Builtin Kit ${kitSlug} plugin directory must not be a symbolic link: ${pluginDir}`);
    }
    if (!entry.isDirectory()) continue;
    let pluginManifest: Record<string, unknown>;
    try {
      pluginManifest = readJsonFile(path.join(pluginDir, 'package.json'));
    } catch (error) {
      throw new Error(`Invalid builtin plugin directory ${pluginDir}: ${(error as Error).message}`);
    }
    const name = pluginManifest.name;
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new Error(`Invalid builtin plugin directory ${pluginDir}: package name is required`);
    }
    if (byName.has(name)) throw new Error(`Builtin Kit ${kitSlug} has duplicate plugin ${name}`);
    byName.set(name, pluginDir);
  }
  for (const name of byName.keys()) {
    if (!declared.has(name)) throw new Error(`Builtin Kit ${kitSlug} has undeclared plugin ${name}`);
  }
  for (const name of declaredNames) {
    if (!byName.has(name)) throw new Error(`Builtin Kit ${kitSlug} is missing declared plugin ${name}`);
  }
  return declaredNames.map((name) => byName.get(name) as string);
}

function discoverMain(rootDir: string, pkg: Record<string, unknown>): PluginMain | null {
  if (typeof pkg.main !== 'string' || pkg.main.length === 0) return null;
  const outputFile = resolveInsidePlugin(rootDir, pkg.main, 'Plugin package.json main');
  const distDir = path.dirname(outputFile);
  const sourceDir = path.join(rootDir, 'main', 'src');
  return { sourceDir, distDir, entryFile: path.join(sourceDir, 'index.ts'), outputFile };
}

function discoverPanels(rootDir: string, pkg: Record<string, unknown>): PluginPanel[] {
  const ceEditor = objectValue(pkg['ce-editor']);
  const contribute = objectValue(ceEditor?.contribute);
  const panel = objectValue(contribute?.panel) ?? {};
  return Object.entries(panel).map(([name, value]) => {
    const definition = objectValue(value);
    if (!definition || typeof definition.entry !== 'string' || definition.entry.length === 0) {
      throw new Error(`Plugin "${String(pkg.name ?? rootDir)}" panel contribution "${name}" must be an object with an entry field`);
    }
    const htmlOutputFile = resolveInsidePlugin(
      rootDir,
      definition.entry,
      `Plugin "${String(pkg.name ?? rootDir)}" panel contribution "${name}" entry`,
    );
    const distDir = path.dirname(htmlOutputFile);
    const baseDir = path.dirname(distDir);
    const sourceDir = path.join(baseDir, 'src');
    return {
      name,
      entry: definition.entry,
      sourceDir,
      distDir,
      scriptEntryFile: path.join(sourceDir, 'index.ts'),
      htmlSourceFile: path.join(sourceDir, 'index.html'),
      cssSourceFile: path.join(sourceDir, 'index.css'),
      htmlOutputFile,
      jsOutputFile: path.join(distDir, 'index.js'),
      cssOutputFile: path.join(distDir, 'index.css'),
    };
  });
}

export function discoverPlugin(pluginDir: string): PluginProject {
  const rootDir = resolvePluginDir(pluginDir);
  const packageJsonPath = resolveInsidePlugin(rootDir, 'package.json', 'Plugin package.json');
  const pkg = readJsonFile(packageJsonPath);
  return {
    rootDir,
    packageJsonPath,
    tsconfigPath: path.join(rootDir, 'tsconfig.json'),
    pkg,
    main: discoverMain(rootDir, pkg),
    panels: discoverPanels(rootDir, pkg),
  };
}

export function discoverAllPlugins(repoRoot: string): string[] {
  const rootDir = path.resolve(repoRoot);
  const results: string[] = [];
  appendPluginDirs(results, path.join(rootDir, 'plugins'));
  const kitsRoot = path.join(rootDir, 'kits');
  let kits: fs.Dirent[] = [];
  try {
    kits = fs.readdirSync(kitsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const kit of kits) {
    if (kit.isSymbolicLink()) throw new Error(`Kit directory must not be a symbolic link: ${path.join(kitsRoot, kit.name)}`);
    if (!kit.isDirectory()) continue;
    appendPluginDirs(results, path.join(kitsRoot, kit.name, 'plugins'));
  }
  return results.sort();
}

export function discoverRuntimePlugins(
  repoRoot: string,
  descriptors: readonly RuntimeKitDescriptor[] = [],
): string[] {
  const rootDir = path.resolve(repoRoot);
  const results: string[] = [];
  appendPluginDirs(results, path.join(rootDir, 'plugins'));
  for (const descriptor of builtinDescriptors(descriptors)) {
    results.push(...discoverDeclaredKitPluginDirs(rootDir, descriptor));
  }
  return results.sort();
}
