import { assertFileExists, resolveInsidePlugin } from './fs.js';
import type { PluginProject } from './types.js';
import { parsePluginPackageManifest } from '@itharbors/kit-core';

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
  const { main } = plugin;
  const manifest = parsePluginPackageManifest(plugin.pkg);
  const { name } = manifest;
  resolveInsidePlugin(plugin.rootDir, manifest.main, `Plugin "${name}" package.json main`);
  if (!main) throw new Error(`Plugin "${name}" package.json main must point to a dist JavaScript entry`);
  for (const [panelName, definition] of Object.entries(manifest.contribute.panel ?? {})) {
    if (!isDistPanelEntry(definition.entry)) {
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
  const manifest = parsePluginPackageManifest(plugin.pkg);
  const { name, main: mainEntry } = manifest;
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
