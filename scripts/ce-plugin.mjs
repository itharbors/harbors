#!/usr/bin/env node
import {
  buildPlugin,
  checkPlugin,
  discoverAllPlugins,
  discoverPlugin,
  discoverRuntimePlugins,
} from '@itharbors/kit-cli';

import { BUILTIN_KITS } from './lib/builtin-kits.mjs';

function parseArgs(argv) {
  const [command, target] = argv;
  return { command, target };
}

function ensureTarget(target) {
  if (!target) {
    throw new Error('Expected <plugin-dir|--all|--runtime>');
  }
  return target;
}

function discoverTargets(target) {
  const resolvedTarget = ensureTarget(target);
  if (resolvedTarget !== '--all' && resolvedTarget !== '--runtime') {
    return [target];
  }

  const plugins = resolvedTarget === '--runtime'
    ? discoverRuntimePlugins(process.cwd(), BUILTIN_KITS.map((kit) => kit.slug))
    : discoverAllPlugins(process.cwd());
  if (plugins.length === 0) {
    throw new Error('No plugins found');
  }
  return plugins;
}

function run(command, target) {
  switch (command) {
    case 'check':
      for (const pluginDir of discoverTargets(target)) {
        checkPlugin(discoverPlugin(pluginDir));
      }
      return;
    case 'build':
      for (const pluginDir of discoverTargets(target)) {
        buildPlugin(discoverPlugin(pluginDir));
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
