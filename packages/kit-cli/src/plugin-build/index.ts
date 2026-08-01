import { copyPanelAssets, copyPreparedMainAssets } from './assets.js';
import { cleanDir } from './fs.js';
import type { PluginProject } from './types.js';
import { compileMainScript, compilePanelScripts } from './scripts.js';
import { copyPanelStyles } from './styles.js';
import { validateBuiltOutputs, validatePluginManifest } from './validate.js';

export * from './assets.js';
export * from './discover.js';
export * from './fs.js';
export * from './scripts.js';
export * from './styles.js';
export * from './types.js';
export * from './validate.js';

export function buildPlugin(plugin: PluginProject): void {
  validatePluginManifest(plugin);
  if (plugin.main) {
    cleanDir(plugin.main.distDir);
    compileMainScript(plugin);
    copyPreparedMainAssets(plugin);
  }
  for (const panel of plugin.panels) cleanDir(panel.distDir);
  compilePanelScripts(plugin);
  copyPanelStyles(plugin);
  copyPanelAssets(plugin);
  validateBuiltOutputs(plugin);
}

export function checkPlugin(plugin: PluginProject): void {
  validatePluginManifest(plugin);
  validateBuiltOutputs(plugin);
}
