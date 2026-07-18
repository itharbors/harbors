import { spawn } from 'node:child_process';

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

const defaultKit = parsed.kit;
const baseEnv = { ...process.env };
const serverEnv = { ...baseEnv };
const gatewayPort = parsePort(baseEnv.PORT, 8080);
const devPages = [
  ['Editor', '/'],
  ['Layout Kit', '/?page=layout-kit'],
  ['UI Kit', '/?page=ui-kit'],
];

if (defaultKit) {
  serverEnv.CE_DEFAULT_KIT = defaultKit;
}

console.log('Starting ITHARBORS dev stack');
if (defaultKit) {
  console.log(`Default kit: ${defaultKit}`);
}
printDevPages(gatewayPort, devPages);

const children = [
  start('gateway', ['run', 'dev', '-w', 'packages/gateway'], baseEnv),
  start('server', ['run', 'dev', '-w', 'packages/server'], serverEnv),
  start('client', ['run', 'dev', '-w', 'packages/client'], baseEnv),
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
  const child = spawn('npm', args, {
    env,
    stdio: 'inherit',
  });

  child.on('error', (error) => {
    console.error(`[${name}] failed to start:`, error.message);
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

function parsePort(value, fallback) {
  const port = parseInt(value || '', 10);
  return Number.isFinite(port) ? port : fallback;
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
  npm run dev
  npm run dev -- --kit <kit-package-name-or-path>

Examples:
  npm run dev -- --kit @itharbors/kit-default
  npm run dev -- --kit ./kits/default
  npm run dev -- --kit-path /absolute/path/to/kit
`.trim());
}
