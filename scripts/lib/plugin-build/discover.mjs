import fs from 'node:fs';
import path from 'node:path';
import { BUILTIN_KITS } from '../builtin-kits.mjs';
import { readJsonFile, resolvePluginDir } from './fs.mjs';

function appendPluginDirs(results, pluginsRoot) {
  if (!fs.existsSync(pluginsRoot)) return;

  for (const entry of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pluginDir = path.join(pluginsRoot, entry.name);
    if (fs.existsSync(path.join(pluginDir, 'package.json'))) {
      results.push(pluginDir);
    }
  }
}

function requirePluginNames(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)
    || value.some((item) => typeof item !== 'string' || item.trim().length === 0)
    || new Set(value).size !== value.length) {
    throw new Error(`${label} must contain unique non-empty plugin names`);
  }
  return [...value];
}

function discoverBuiltinKitPluginDirs(rootDir, kit) {
  const kitRoot = path.join(rootDir, 'kits', kit.slug);
  const manifestPath = path.join(kitRoot, 'package.json');
  let manifest;
  try {
    manifest = readJsonFile(manifestPath);
  } catch (error) {
    throw new Error(`Invalid builtin Kit ${kit.slug} package.json: ${error.message}`);
  }
  const declaration = manifest?.['ce-editor']?.kit;
  if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) {
    throw new Error(`Builtin Kit ${kit.slug} must declare ce-editor.kit`);
  }
  const ordinary = requirePluginNames(declaration.plugin, `Builtin Kit ${kit.slug} plugin`);
  const startup = declaration.startup;
  if (startup !== undefined && (!startup || typeof startup !== 'object' || Array.isArray(startup))) {
    throw new Error(`Builtin Kit ${kit.slug} startup must be an object`);
  }
  const startupPlugins = requirePluginNames(
    startup?.plugins,
    `Builtin Kit ${kit.slug} startup.plugins`,
  );
  const ordinarySet = new Set(ordinary);
  const overlap = startupPlugins.find((name) => ordinarySet.has(name));
  if (overlap) {
    throw new Error(`Builtin Kit ${kit.slug} declares ${overlap} as ordinary and startup plugin`);
  }
  const declaredNames = [...ordinary, ...startupPlugins];
  const declared = new Set(declaredNames);
  const pluginsRoot = path.join(kitRoot, 'plugins');
  const pluginDirectories = fs.existsSync(pluginsRoot)
    ? fs.readdirSync(pluginsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))
    : [];
  const byName = new Map();
  for (const entry of pluginDirectories) {
    const pluginDir = path.join(pluginsRoot, entry.name);
    const packageJsonPath = path.join(pluginDir, 'package.json');
    let pluginManifest;
    try {
      pluginManifest = readJsonFile(packageJsonPath);
    } catch (error) {
      throw new Error(`Invalid builtin plugin directory ${pluginDir}: ${error.message}`);
    }
    if (typeof pluginManifest?.name !== 'string' || pluginManifest.name.trim().length === 0) {
      throw new Error(`Invalid builtin plugin directory ${pluginDir}: package name is required`);
    }
    if (byName.has(pluginManifest.name)) {
      throw new Error(`Builtin Kit ${kit.slug} has duplicate plugin ${pluginManifest.name}`);
    }
    byName.set(pluginManifest.name, pluginDir);
  }
  for (const name of byName.keys()) {
    if (!declared.has(name)) throw new Error(`Builtin Kit ${kit.slug} has undeclared plugin ${name}`);
  }
  for (const name of declaredNames) {
    if (!byName.has(name)) throw new Error(`Builtin Kit ${kit.slug} is missing declared plugin ${name}`);
  }
  return declaredNames.map((name) => byName.get(name));
}

function discoverMain(rootDir, pkg) {
  if (typeof pkg.main !== 'string' || !pkg.main) return null;
  const distFile = path.join(rootDir, pkg.main);
  const distDir = path.dirname(distFile);
  return {
    sourceDir: path.join(rootDir, 'main', 'src'),
    distDir,
    entryFile: path.join(rootDir, 'main', 'src', 'index.ts'),
    outputFile: distFile,
  };
}

function discoverPanels(rootDir, pkg) {
  const panel = pkg['ce-editor']?.contribute?.panel ?? {};
  return Object.entries(panel).map(([name, definition]) => {
    if (!definition || typeof definition !== 'object' || typeof definition.entry !== 'string' || !definition.entry) {
      throw new Error(`Plugin "${pkg.name ?? rootDir}" panel contribution "${name}" must be an object with an entry field`);
    }
    const distFile = path.join(rootDir, definition.entry);
    const baseDir = path.dirname(path.dirname(distFile));
    const sourceDir = path.join(baseDir, 'src');
    return {
      name,
      entry: definition.entry,
      sourceDir,
      distDir: path.dirname(distFile),
      scriptEntryFile: path.join(sourceDir, 'index.ts'),
      htmlSourceFile: path.join(sourceDir, 'index.html'),
      cssSourceFile: path.join(sourceDir, 'index.css'),
      htmlOutputFile: distFile,
      jsOutputFile: path.join(path.dirname(distFile), 'index.js'),
      cssOutputFile: path.join(path.dirname(distFile), 'index.css'),
    };
  });
}

export function discoverPlugin(pluginDir) {
  const rootDir = resolvePluginDir(pluginDir);
  const packageJsonPath = path.join(rootDir, 'package.json');
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

export function discoverAllPlugins(repoRoot) {
  const rootDir = path.resolve(repoRoot);
  const results = [];

  appendPluginDirs(results, path.join(rootDir, 'plugins'));

  const kitsRoot = path.join(rootDir, 'kits');
  if (fs.existsSync(kitsRoot)) {
    for (const kit of fs.readdirSync(kitsRoot, { withFileTypes: true })) {
      if (!kit.isDirectory()) continue;
      appendPluginDirs(results, path.join(kitsRoot, kit.name, 'plugins'));
    }
  }

  return results.sort();
}

export function discoverRuntimePlugins(repoRoot) {
  const rootDir = path.resolve(repoRoot);
  const results = [];

  appendPluginDirs(results, path.join(rootDir, 'plugins'));
  for (const kit of BUILTIN_KITS) {
    results.push(...discoverBuiltinKitPluginDirs(rootDir, kit));
  }

  return results.sort();
}
