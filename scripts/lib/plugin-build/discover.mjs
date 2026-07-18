import fs from 'node:fs';
import path from 'node:path';
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
