import path from 'node:path';
import { assertFileExists } from './fs.mjs';

function isDistJavaScriptEntry(value) {
  return typeof value === 'string' && /(^|\/)dist\/.+\.(m?js|cjs)$/u.test(value);
}

function isDistPanelEntry(value) {
  return typeof value === 'string' && /(^|\/)dist\/index\.html$/u.test(value);
}

function resolveInsidePlugin(rootDir, value, label) {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(rootDir, value);
  if (resolved === root || !resolved.startsWith(root + path.sep)) {
    throw new Error(`${label} must stay inside the plugin directory`);
  }
  return resolved;
}

export function validatePluginManifest(plugin) {
  const { pkg, main, panels } = plugin;

  if (!pkg?.name) {
    throw new Error('Plugin package.json missing name');
  }
  if (!pkg?.['ce-editor']) {
    throw new Error(`Plugin "${pkg.name}" missing "ce-editor" field in package.json`);
  }
  if (!isDistJavaScriptEntry(pkg.main)) {
    throw new Error(`Plugin "${pkg.name}" package.json main must point to a dist JavaScript entry`);
  }
  resolveInsidePlugin(plugin.rootDir, pkg.main, `Plugin "${pkg.name}" package.json main`);
  if (main) {
    assertFileExists(main.entryFile, 'plugin main source');
  }

  for (const [panelName, definition] of Object.entries(pkg['ce-editor']?.contribute?.panel ?? {})) {
    if (!definition || typeof definition !== 'object' || typeof definition.entry !== 'string' || !definition.entry) {
      throw new Error(`Plugin "${pkg.name}" panel contribution "${panelName}" must be an object with an entry field`);
    }
    if (!isDistPanelEntry(definition.entry)) {
      throw new Error(`Plugin "${pkg.name}" panel contribution "${panelName}" entry must point to a dist index.html file`);
    }
    resolveInsidePlugin(plugin.rootDir, definition.entry, `Plugin "${pkg.name}" panel contribution "${panelName}" entry`);
  }

  for (const panel of panels) {
    assertFileExists(panel.scriptEntryFile, `panel script source for ${panel.name}`);
    assertFileExists(panel.htmlSourceFile, `panel html source for ${panel.name}`);
  }
}

export function validateBuiltOutputs(plugin) {
  const { rootDir, pkg, main, panels } = plugin;

  assertFileExists(resolveInsidePlugin(rootDir, pkg.main, `Plugin "${pkg.name}" package.json main`), 'plugin main');
  if (main) {
    assertFileExists(main.outputFile, 'plugin main');
  }

  for (const panel of panels) {
    assertFileExists(panel.htmlOutputFile, `panel entry for ${panel.name}`);
    assertFileExists(panel.jsOutputFile, `panel script for ${panel.name}`);
    assertFileExists(panel.cssOutputFile, `panel style for ${panel.name}`);
  }
}
