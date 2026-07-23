#!/usr/bin/env node
import { discoverAllPlugins, discoverPlugin } from './lib/plugin-build/discover.mjs';
import { cleanDir } from './lib/plugin-build/fs.mjs';
import { compileMainScript, compilePanelScripts } from './lib/plugin-build/scripts.mjs';
import { copyPanelStyles } from './lib/plugin-build/styles.mjs';
import { copyPanelAssets } from './lib/plugin-build/assets.mjs';
import { validateBuiltOutputs, validatePluginManifest } from './lib/plugin-build/validate.mjs';

function parseArgs(argv) {
  const [command, target] = argv;
  return { command, target };
}

function ensureTarget(target) {
  if (!target) {
    throw new Error('Expected <plugin-dir|--all>');
  }
  return target;
}

function discoverTargets(target) {
  if (ensureTarget(target) !== '--all') {
    return [target];
  }

  const plugins = discoverAllPlugins(process.cwd());
  if (plugins.length === 0) {
    throw new Error('No plugins found');
  }
  return plugins;
}

function buildPlugin(plugin) {
  if (plugin.main) {
    cleanDir(plugin.main.distDir);
    compileMainScript(plugin);
  }

  for (const panel of plugin.panels) {
    cleanDir(panel.distDir);
  }
  compilePanelScripts(plugin);
  copyPanelStyles(plugin);
  copyPanelAssets(plugin);
  validateBuiltOutputs(plugin);
}

function run(command, target) {
  switch (command) {
    case 'check':
      for (const pluginDir of discoverTargets(target)) {
        const plugin = discoverPlugin(pluginDir);
        validatePluginManifest(plugin);
        validateBuiltOutputs(plugin);
      }
      return;
    case 'build':
      for (const pluginDir of discoverTargets(target)) {
        const plugin = discoverPlugin(pluginDir);
        validatePluginManifest(plugin);
        buildPlugin(plugin);
      }
      return;
    default:
      throw new Error(`Unknown command: ${command ?? '<missing>'}`);
  }
}

try {
  const { command, target } = parseArgs(process.argv.slice(2));
  run(command, target);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
