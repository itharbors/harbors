import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCachedTask } from './build-cache.mjs';

const copyInputCommand = [
  "import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
  "mkdirSync('dist', { recursive: true });",
  "writeFileSync('dist/output.txt', readFileSync('src/input.txt'));",
  "appendFileSync('executions.log', 'run\\n');",
].join(' ');

test('builds once and hits the cache when the task inputs are unchanged', async (t) => {
  const { rootDir, cacheDir, task } = await createFixture(t);
  const first = await runCachedTask({ rootDir, cacheDir, task });
  const second = await runCachedTask({ rootDir, cacheDir, task });

  assert.equal(first.status, 'built');
  assert.equal(second.status, 'hit');
  assert.equal(await readFile(join(rootDir, 'executions.log'), 'utf8'), 'run\n');
  assert.match(second.resultDigest, /^[a-f0-9]{64}$/u);
});

test('rebuilds when an input file changes', async (t) => {
  const fixture = await createFixture(t);
  await primeCache(fixture);
  await writeFile(join(fixture.rootDir, 'src', 'input.txt'), 'changed');

  assert.equal((await runCachedTask(fixture)).status, 'built');
  await assertExecutionCount(fixture.rootDir, 2);
});

test('rebuilds when an input file is added', async (t) => {
  const fixture = await createFixture(t);
  await primeCache(fixture);
  await writeFile(join(fixture.rootDir, 'src', 'added.txt'), 'added');

  assert.equal((await runCachedTask(fixture)).status, 'built');
  await assertExecutionCount(fixture.rootDir, 2);
});

test('rebuilds when an input file is deleted', async (t) => {
  const fixture = await createFixture(t);
  await writeFile(join(fixture.rootDir, 'src', 'added.txt'), 'added');
  await primeCache(fixture);
  await rm(join(fixture.rootDir, 'src', 'added.txt'));

  assert.equal((await runCachedTask(fixture)).status, 'built');
  await assertExecutionCount(fixture.rootDir, 2);
});

test('rebuilds when a declared output is missing', async (t) => {
  const fixture = await createFixture(t);
  await primeCache(fixture);
  await rm(join(fixture.rootDir, 'dist', 'output.txt'));

  assert.equal((await runCachedTask(fixture)).status, 'built');
  await assertExecutionCount(fixture.rootDir, 2);
});

test('rebuilds when a declared output changes', async (t) => {
  const fixture = await createFixture(t);
  await primeCache(fixture);
  await writeFile(join(fixture.rootDir, 'dist', 'output.txt'), 'corrupted');

  assert.equal((await runCachedTask(fixture)).status, 'built');
  await assertExecutionCount(fixture.rootDir, 2);
});

test('rebuilds when an extra declared output appears', async (t) => {
  const fixture = await createFixture(t);
  await primeCache(fixture);
  await writeFile(join(fixture.rootDir, 'dist', 'extra.txt'), 'extra');

  assert.equal((await runCachedTask(fixture)).status, 'built');
  await assertExecutionCount(fixture.rootDir, 2);
});

test('rebuilds when a dependency result digest changes', async (t) => {
  const fixture = await createFixture(t, { dependencyDigests: ['upstream-a'] });
  await primeCache(fixture);

  assert.equal((await runCachedTask({ ...fixture, dependencyDigests: ['upstream-b'] })).status, 'built');
  await assertExecutionCount(fixture.rootDir, 2);
});

test('does not write a cache record when the child command fails', async (t) => {
  const fixture = await createFixture(t);
  fixture.task = {
    ...fixture.task,
    command: { file: process.execPath, args: ['-e', 'process.exit(7)'] },
  };

  await assert.rejects(runCachedTask(fixture), (error) => error.status === 7);
  await assert.rejects(readdir(fixture.cacheDir), { code: 'ENOENT' });
});

test('rebuilds when the existing cache record is invalid JSON', async (t) => {
  const fixture = await createFixture(t);
  await primeCache(fixture);
  await writeFile(await cacheRecordPath(fixture.cacheDir), '{not json');

  assert.equal((await runCachedTask(fixture)).status, 'built');
  await assertExecutionCount(fixture.rootDir, 2);
});

test('rebuilds when the existing cache record has another schema version', async (t) => {
  const fixture = await createFixture(t);
  await primeCache(fixture);
  const recordPath = await cacheRecordPath(fixture.cacheDir);
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  await writeFile(recordPath, JSON.stringify({ ...record, schemaVersion: 999 }));

  assert.equal((await runCachedTask(fixture)).status, 'built');
  await assertExecutionCount(fixture.rootDir, 2);
});

test('force rebuilds an otherwise valid cache hit', async (t) => {
  const fixture = await createFixture(t);
  await primeCache(fixture);

  assert.equal((await runCachedTask({ ...fixture, force: true })).status, 'built');
  await assertExecutionCount(fixture.rootDir, 2);
});

function createFixtureTask() {
  return {
    name: 'fixture-build',
    command: { file: process.execPath, args: ['-e', copyInputCommand] },
    inputs: ['src'],
    outputs: ['dist'],
  };
}

async function createFixture(t, options = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'harbors-build-cache-'));
  await mkdir(join(rootDir, 'src'), { recursive: true });
  await writeFile(join(rootDir, 'src', 'input.txt'), 'initial');
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  return { rootDir, cacheDir: join(rootDir, '.cache'), task: createFixtureTask(), ...options };
}

async function primeCache(options) {
  assert.equal((await runCachedTask(options)).status, 'built');
}

async function assertExecutionCount(rootDir, count) {
  assert.equal(await readFile(join(rootDir, 'executions.log'), 'utf8'), 'run\n'.repeat(count));
}

async function cacheRecordPath(cacheDir) {
  const records = await readdir(cacheDir);
  assert.equal(records.length, 1);
  return join(cacheDir, records[0]);
}
