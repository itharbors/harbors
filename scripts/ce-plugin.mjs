#!/usr/bin/env node
import path from 'node:path';

import {
  buildPlugin,
  checkPlugin,
  discoverAllPlugins,
  discoverPlugin,
} from '@itharbors/kit-cli';

function parseArgs(argv) {
  const [command, target] = argv;
  return { command, target };
}

function ensureTarget(target) {
  if (!target) {
    throw new Error('Expected <plugin-dir|--all|--framework>');
  }
  return target;
}

async function discoverTargets(command, target) {
  const resolvedTarget = ensureTarget(target);
  if (resolvedTarget !== '--all' && resolvedTarget !== '--framework') {
    return [target];
  }

  let plugins;
  if (resolvedTarget === '--framework') {
    const frameworkPluginRoot = `${path.resolve(process.cwd(), 'plugins')}${path.sep}`;
    plugins = discoverAllPlugins(process.cwd()).filter((plugin) =>
      `${path.resolve(plugin)}${path.sep}`.startsWith(frameworkPluginRoot));
  } else {
    plugins = discoverAllPlugins(process.cwd());
  }
  if (plugins.length === 0) {
    throw new Error('No plugins found');
  }
  return plugins;
}

async function run(command, target) {
  switch (command) {
    case 'check':
      for (const pluginDir of await discoverTargets(command, target)) {
        checkPlugin(discoverPlugin(pluginDir));
      }
      return;
    case 'build':
      for (const pluginDir of await discoverTargets(command, target)) {
        buildPlugin(discoverPlugin(pluginDir));
      }
      return;
    default:
      throw new Error(`Unknown command: ${command ?? '<missing>'}`);
  }
}

try {
  const { command, target } = parseArgs(process.argv.slice(2));
  await run(command, target);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
