import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkOfficialKit, runCheckedCommand } from './kit-check.mjs';
import { runCheckKitCli } from '../check-kit.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const cli = path.join(repositoryRoot, 'scripts/check-kit.mjs');

function expectedCommands({ artifactName, slug, workspaces, plugins, outputDirectory, preparesResources = false }) {
  const artifactPath = path.join(outputDirectory, artifactName);
  return [
    ...workspaces.map((workspace) => ['npm', ['run', 'build', '-w', workspace]]),
    ...plugins.map((plugin) => [process.execPath, [
      'scripts/ce-plugin.mjs', 'build', `kits/${slug}/plugins/${plugin}`,
    ]]),
    ...(preparesResources ? [[process.execPath, ['scripts/prepare-notification-skill-resource.mjs']]] : []),
    ['npm', ['test', '-w', `@itharbors/kit-${slug}`]],
    [process.execPath, ['packages/kit-cli/dist/cli.js', 'validate', `kits/${slug}`]],
    [process.execPath, [
      'packages/kit-cli/dist/cli.js', 'pack', `kits/${slug}`, '--output', artifactPath,
    ]],
    [process.execPath, ['packages/kit-cli/dist/cli.js', 'inspect', artifactPath, '--json']],
  ];
}

async function checkCommandSequence({
  artifactName = 'kit-mysql-0.1.0-preview.1-any-any.hkit',
  slug,
  workspaces,
  plugins,
  preparesResources = false,
}) {
  const outputDirectory = await mkdtemp(path.join(tmpdir(), `kit-check-${slug}-`));
  const calls = [];
  try {
    const result = await checkOfficialKit({
      repositoryRoot,
      slug,
      outputDirectory,
      runCommand: async (command, args, options) => calls.push([command, args, options]),
    });
    assert.equal(result.artifactPath, path.join(outputDirectory, artifactName));
    assert.equal(result.kit.slug, slug);
    assert.deepEqual(
      calls,
      expectedCommands({ artifactName, slug, workspaces, plugins, outputDirectory, preparesResources })
        .map(([command, args]) => [command, args, { cwd: repositoryRoot }]),
    );
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

test('checks MySQL with its exact affected build, test, pack, and inspect sequence', async () => {
  await checkCommandSequence({
    slug: 'mysql',
    workspaces: [
      '@itharbors/mysql-contracts',
      '@itharbors/relationship-graph',
      '@itharbors/kit-core',
      '@itharbors/kit-cli',
    ],
    plugins: [
      'mysql-core',
      'mysql-data',
      'mysql-explorer',
      'mysql-relationships',
      'mysql-schema',
      'mysql-sql',
    ],
  });
});

test('checks Notifications and prepares its skill resource after every plugin build', async () => {
  await checkCommandSequence({
    slug: 'notifications',
    artifactName: 'kit-notifications-0.1.0-preview.1-any-any.hkit',
    workspaces: ['@itharbors/kit-core', '@itharbors/kit-cli'],
    plugins: ['notification-background', 'notification-center'],
    preparesResources: true,
  });
});

test('checks SQLite with its exact affected build, test, pack, and inspect sequence', async () => {
  await checkCommandSequence({
    slug: 'sqlite',
    artifactName: 'kit-sqlite-0.1.0-preview.1-darwin-arm64-abi127.hkit',
    workspaces: [
      '@itharbors/sqlite-contracts',
      '@itharbors/relationship-graph',
      '@itharbors/kit-core',
      '@itharbors/kit-cli',
    ],
    plugins: [
      'sqlite-core',
      'sqlite-data',
      'sqlite-explorer',
      'sqlite-relationships',
      'sqlite-schema',
      'sqlite-sql',
    ],
  });
});

test('rejects an unknown slug before running a command', async () => {
  const calls = [];
  await assert.rejects(
    checkOfficialKit({
      repositoryRoot,
      slug: 'unknown',
      outputDirectory: path.join(tmpdir(), 'kit-check-unknown'),
      runCommand: async (...args) => calls.push(args),
    }),
    /unknown official Kit slug/i,
  );
  assert.deepEqual(calls, []);
});

test('rejects a relative output directory before running commands or creating it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-check-relative-'));
  const outputDirectory = path.relative(process.cwd(), path.join(root, 'output'));
  const calls = [];
  try {
    await assert.rejects(
      checkOfficialKit({
        repositoryRoot,
        slug: 'sqlite',
        outputDirectory,
        runCommand: async (...args) => calls.push(args),
      }),
      /outputDirectory must be a non-empty absolute path/u,
    );
    assert.deepEqual(calls, []);
    await assert.rejects(access(path.resolve(outputDirectory)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('normalizes an absolute output directory before every artifact operation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-check-normalized-'));
  const outputDirectory = path.join(root, 'parent', '..', 'output');
  const normalizedOutputDirectory = path.join(root, 'output');
  const calls = [];
  try {
    const result = await checkOfficialKit({
      repositoryRoot,
      slug: 'mysql',
      outputDirectory,
      runCommand: async (command, args, options) => calls.push([command, args, options]),
    });
    const artifactPath = path.join(normalizedOutputDirectory, 'kit-mysql-0.1.0-preview.1-any-any.hkit');
    assert.equal(result.artifactPath, artifactPath);
    assert.equal(calls.at(-2)[1].at(-1), artifactPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runCheckedCommand rejects non-zero exits, signals, error events, and invalid spawn input', async () => {
  await assert.rejects(
    runCheckedCommand(process.execPath, ['-e', 'process.exit(3)']),
    /exited with code 3/u,
  );
  await assert.rejects(
    runCheckedCommand(process.execPath, ['-e', "process.kill(process.pid, 'SIGTERM')"]),
    /terminated by signal SIGTERM/u,
  );
  await assert.rejects(
    runCheckedCommand(`missing-kit-check-command-${process.pid}`, []),
    /ENOENT/u,
  );
  await assert.rejects(
    runCheckedCommand(null, []),
    /ERR_INVALID_ARG_TYPE|The "file" argument/u,
  );
});

test('the CLI reports one safely parseable ERROR line for unsafe or empty failures', async () => {
  for (const [error, expected] of [
    [
      new Error('first\r\nsecond\u2028third\u2029fourth\u0000fifth\u001b[31mred\u007f\u0085last'),
      'ERROR=first second third fourth fifth [31mred last\n',
    ],
    [new Error(''), 'ERROR=Unknown error\n'],
  ]) {
    const stderr = [];
    const code = await runCheckKitCli(
      ['sqlite', '--output-directory', path.resolve(tmpdir(), 'kit-check-cli-output')],
      { stdout: { write: () => undefined }, stderr: { write: (value) => stderr.push(value) } },
      { checkOfficialKit: async () => { throw error; } },
    );
    assert.equal(code, 1);
    assert.equal(stderr.join(''), expected);
    assert.equal(stderr.join('').split('\n').length, 2);
  }
});

test('the CLI rejects relative output paths and extra arguments in a real process', () => {
  for (const args of [
    ['sqlite', '--output-directory', 'relative-output'],
    ['sqlite', '--output-directory', path.resolve(tmpdir(), 'kit-check-cli-output'), '--extra'],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /Usage:/u);
  }
});
