import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runBuild, runBuildCli } from '../build.mjs';

const buildCli = fileURLToPath(new URL('../build.mjs', import.meta.url));
const fixtureCommand = [
  "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
  "mkdirSync('dist', { recursive: true });",
  "writeFileSync('dist/output.txt', readFileSync('src/input.txt'));",
].join(' ');

test('prints BUILD then HIT for the same cached task and rebuilds when forced', async (t) => {
  const fixture = await createFixture(t);

  const first = await runPlan(fixture);
  const second = await runPlan(fixture);
  const forced = await runPlan(fixture, true);

  assert.equal(first, 'BUILD fixture:one\n');
  assert.equal(second, 'HIT fixture:one\n');
  assert.equal(forced, 'BUILD fixture:one\n');
  assert.equal(await readFile(path.join(fixture.rootDir, 'dist', 'output.txt'), 'utf8'), 'input');
});

test('fails before running a task whose dependency was not completed', async (t) => {
  const fixture = await createFixture(t);
  fixture.plan.tasks[0].dependencies = ['fixture:missing'];
  const output = [];

  await assert.rejects(
    runBuild({
      rootDir: fixture.rootDir,
      graphName: 'fixture',
      force: false,
      stdout: writer(output),
      plan: fixture.plan,
    }),
    /fixture:one depends on task that has not completed: fixture:missing/,
  );
  assert.equal(output.join(''), 'FAIL fixture:one\n');
});

test('prints usage and returns 2 for unknown or multiple graph arguments', () => {
  for (const args of [['unknown'], ['all', 'runtime']]) {
    const result = spawnSync(process.execPath, [buildCli, ...args], { encoding: 'utf8' });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage: node scripts\/build\.mjs/u);
  }
});

test('preserves a child build exit status through the CLI', async (t) => {
  const fixture = await createFixture(t, {
    command: { file: process.execPath, args: ['-e', 'process.exit(7)'] },
  });
  const output = [];

  const status = await runBuildCli(['all'], { stdout: writer(output), stderr: writer(output) }, {
    rootDir: fixture.rootDir,
    createPlan: () => fixture.plan,
  });

  assert.equal(status, 7);
  assert.equal(output.join(''), 'FAIL fixture:one\n');
});

async function runPlan(fixture, force = false) {
  const output = [];
  await runBuild({
    rootDir: fixture.rootDir,
    graphName: 'fixture',
    force,
    stdout: writer(output),
    plan: fixture.plan,
  });
  return output.join('');
}

function writer(output) {
  return { write: (value) => output.push(value) };
}

async function createFixture(t, { command } = {}) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'harbors-build-cli-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await mkdir(path.join(rootDir, 'src'), { recursive: true });
  await writeFile(path.join(rootDir, 'src', 'input.txt'), 'input');
  const task = {
    name: 'fixture:one',
    command: command ?? { file: process.execPath, args: ['-e', fixtureCommand] },
    inputs: ['src'],
    outputs: ['dist'],
    dependencies: [],
  };
  return {
    rootDir,
    plan: {
      cacheDir: path.join(rootDir, '.cache', 'harbors-build', 'v1'),
      tasks: [task],
    },
  };
}
