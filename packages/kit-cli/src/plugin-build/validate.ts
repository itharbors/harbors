import { assertFileExists, resolveInsidePlugin } from './fs.js';
import type { PluginProject } from './types.js';

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isDistJavaScriptEntry(value: unknown): value is string {
  return typeof value === 'string' && /(^|\/)dist\/.+\.(m?js|cjs)$/u.test(value);
}

function isDistPanelEntry(value: unknown): value is string {
  return typeof value === 'string' && /(^|\/)dist\/index\.html$/u.test(value);
}

export function validateRuntimePluginManifest(plugin: PluginProject): void {
  const { pkg, main } = plugin;
  const name = pkg.name;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('Plugin package.json missing name');
  }
  const ceEditor = objectValue(pkg['ce-editor']);
  if (!ceEditor) throw new Error(`Plugin "${name}" missing "ce-editor" field in package.json`);
  if (!isDistJavaScriptEntry(pkg.main)) {
    throw new Error(`Plugin "${name}" package.json main must point to a dist JavaScript entry`);
  }
  resolveInsidePlugin(plugin.rootDir, pkg.main, `Plugin "${name}" package.json main`);
  if (!main) throw new Error(`Plugin "${name}" package.json main must point to a dist JavaScript entry`);
  const contribute = objectValue(ceEditor.contribute);
  const panelDefinitions = objectValue(contribute?.panel) ?? {};
  for (const [panelName, definitionValue] of Object.entries(panelDefinitions)) {
    const definition = objectValue(definitionValue);
    if (!definition || !isDistPanelEntry(definition.entry)) {
      throw new Error(`Plugin "${name}" panel contribution "${panelName}" entry must point to a dist index.html file`);
    }
    resolveInsidePlugin(plugin.rootDir, definition.entry, `Plugin "${name}" panel contribution "${panelName}" entry`);
  }
}

export function validatePluginManifest(plugin: PluginProject): void {
  validateRuntimePluginManifest(plugin);
  if (plugin.main) assertFileExists(plugin.main.entryFile, 'plugin main source');
  for (const panel of plugin.panels) {
    assertFileExists(panel.scriptEntryFile, `panel script source for ${panel.name}`);
    assertFileExists(panel.htmlSourceFile, `panel html source for ${panel.name}`);
  }
}

export function validateBuiltOutputs(plugin: PluginProject): void {
  const name = typeof plugin.pkg.name === 'string' ? plugin.pkg.name : plugin.rootDir;
  const mainEntry = plugin.pkg.main;
  if (!isDistJavaScriptEntry(mainEntry)) {
    throw new Error(`Plugin "${name}" package.json main must point to a dist JavaScript entry`);
  }
  assertFileExists(
    resolveInsidePlugin(plugin.rootDir, mainEntry, `Plugin "${name}" package.json main`),
    'plugin main',
  );
  if (plugin.main) assertFileExists(plugin.main.outputFile, 'plugin main');
  for (const panel of plugin.panels) {
    assertFileExists(panel.htmlOutputFile, `panel entry for ${panel.name}`);
    assertFileExists(panel.jsOutputFile, `panel script for ${panel.name}`);
    assertFileExists(panel.cssOutputFile, `panel style for ${panel.name}`);
  }
}
