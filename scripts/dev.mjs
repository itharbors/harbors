import { spawn } from 'node:child_process';
import path from 'node:path';
import { readdir, lstat, realpath } from 'node:fs/promises';
import { normalizeKitArgument } from './lib/kit-path.mjs';
import { createDevPages, createDevStackEnvironments } from './lib/dev-launcher.mjs';
import { createPnpmSpawnSpec } from './lib/pnpm-spawn.mjs';

const parsed = parseArgs(process.argv.slice(2));

if (parsed.help) {
  printHelp();
  process.exit(0);
}

if (parsed.errors.length > 0) {
  for (const error of parsed.errors) {
    console.error(error);
  }
  printHelp();
  process.exit(1);
}

const requestedKit = normalizeKitArgument(parsed.kit);
const baseEnv = { ...process.env };
const kitsDir = path.join(process.cwd(), 'kits');
const kitSources = await discoverKitSources(kitsDir);
const stack = createDevStackEnvironments(
  baseEnv,
  requestedKit,
  baseEnv.HARBORS_RUNTIME_PROFILE ?? 'development',
  kitSources,
);
const devPages = createDevPages(requestedKit);

console.log('Starting ITHARBORS dev stack');
if (requestedKit) {
  console.log(`Requested Kit: ${requestedKit}`);
}
printDevPages(stack.ports.gateway, devPages);

const children = [
  start('gateway', ['--filter', '@itharbors/gateway', 'run', 'dev'], stack.gatewayEnv),
  start('server', ['--filter', '@itharbors/server', 'run', 'dev'], stack.serverEnv),
  start('client', ['--filter', '@itharbors/client', 'run', 'dev'], stack.clientEnv),
];

let shuttingDown = false;

for (const child of children) {
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    if (code === 0 || signal === 'SIGTERM' || signal === 'SIGINT') return;

    shuttingDown = true;
    stopAll();
    process.exit(code ?? 1);
  });
}

process.on('SIGINT', () => {
  shuttingDown = true;
  stopAll();
});

process.on('SIGTERM', () => {
  shuttingDown = true;
  stopAll();
});

function start(name, args, env) {
  const pnpm = createPnpmSpawnSpec(args, { env });
  const child = spawn(pnpm.command, pnpm.args, {
    ...pnpm.spawnOptions,
    env,
    stdio: 'inherit',
  });

  child.on('error', (error) => {
    console.error(`[${name}] failed to start:`, error.message);
    process.exitCode = 1;
    if (!shuttingDown) {
      shuttingDown = true;
      stopAll();
    }
  });

  return child;
}

function stopAll() {
  for (const child of children) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }
}

function printDevPages(port, pages) {
  const baseUrl = `http://localhost:${port}`;
  console.log('');
  console.log('Available pages:');
  for (const [name, path] of pages) {
    console.log(`  ${name.padEnd(10)} ${baseUrl}${path}`);
  }
  console.log('');
}

function parseArgs(args) {
  const result = {
    kit: '',
    help: false,
    errors: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }

    if (arg === '--kit' || arg === '--kit-path' || arg === '--kitPath') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        result.errors.push(`${arg} requires a kit package name or path`);
        continue;
      }
      result.kit = value;
      index += 1;
      continue;
    }

    if (arg.startsWith('--kit=')) {
      result.kit = arg.slice('--kit='.length);
      continue;
    }

    if (arg.startsWith('--kit-path=')) {
      result.kit = arg.slice('--kit-path='.length);
      continue;
    }

    if (arg.startsWith('--kitPath=')) {
      result.kit = arg.slice('--kitPath='.length);
      continue;
    }

    result.errors.push(`Unknown dev argument: ${arg}`);
  }

  return result;
}

function printHelp() {
  console.log(`
Usage:
  pnpm dev
  pnpm dev -- --kit <kit-package-name-or-path>

Examples:
  pnpm dev -- --kit <package-name>
  pnpm dev -- --kit ./kits/<name>
  pnpm dev -- --kit-path /absolute/path/to/kit
`.trim());
}

async function discoverKitSources(kitsDir) {
  const entries = await readdir(kitsDir, { withFileTypes: true });
  const sources = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(kitsDir, entry.name);
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    sources.push({ directory: await realpath(directory), source: 'builtin' });
  }
  if (sources.length === 0) {
    throw new Error(`No built-in Kits found in ${kitsDir}`);
  }
  return sources;
}
