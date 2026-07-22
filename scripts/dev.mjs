import { spawn } from 'node:child_process';
import { normalizeKitArgument } from './lib/kit-path.mjs';
import { createDevPages, createDevStackEnvironments } from './lib/dev-launcher.mjs';
import { createNpmSpawnSpec } from './lib/npm-spawn.mjs';

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
const stack = createDevStackEnvironments(baseEnv, requestedKit);
const devPages = createDevPages(requestedKit);

console.log('Starting ITHARBORS dev stack');
if (requestedKit) {
  console.log(`Requested Kit: ${requestedKit}`);
}
printDevPages(stack.ports.gateway, devPages);

const children = [
  start('gateway', ['run', 'dev', '-w', 'packages/gateway'], stack.gatewayEnv),
  start('server', ['run', 'dev', '-w', 'packages/server'], stack.serverEnv),
  start('client', ['run', 'dev', '-w', 'packages/client'], stack.clientEnv),
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
  const npm = createNpmSpawnSpec(args, { env });
  const child = spawn(npm.command, npm.args, {
    ...npm.spawnOptions,
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
  npm run dev:web
  npm run dev:web -- --kit <kit-package-name-or-path>

Examples:
  npm run dev:web -- --kit @itharbors/kit-default
  npm run dev:web -- --kit ./kits/default
  npm run dev:web -- --kit-path /absolute/path/to/kit
`.trim());
}
