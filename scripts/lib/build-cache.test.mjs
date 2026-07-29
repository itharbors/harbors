import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
const replaceOutputCommand = [
  "import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';",
  "rmSync('dist', { recursive: true, force: true });",
  "mkdirSync('dist', { recursive: true });",
  "writeFileSync('dist/output.txt', readFileSync('src/input.txt'));",
  "appendFileSync('executions.log', 'run\\n');",
].join(' ');
const emptyOutputCommand = [
  "import { appendFileSync, mkdirSync, rmSync } from 'node:fs';",
  "rmSync('dist', { recursive: true, force: true });",
  "mkdirSync('dist', { recursive: true });",
  "appendFileSync('executions.log', 'run\\n');",
].join(' ');
const conditionalOutputCommand = [
  "import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';",
  "rmSync('dist', { recursive: true, force: true });",
  "mkdirSync('dist', { recursive: true });",
  "if (existsSync('produce-output')) writeFileSync('dist/output.txt', readFileSync('src/input.txt'));",
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
  assert.equal(cacheDir, join(rootDir, '.cache', 'harbors-build', 'v1'));
  const record = JSON.parse(await readFile(await cacheRecordPath(cacheDir), 'utf8'));
  assert.equal(record.schemaVersion, 1);
});

test('rebuilds when the Node runtime version changes', async (t) => {
  const fixture = await createFixture(t);
  const originalVersion = process.version;
  t.after(() => Object.defineProperty(process, 'version', { value: originalVersion }));
  Object.defineProperty(process, 'version', { value: 'v100.0.0-cache-test' });
  await primeCache(fixture);
  Object.defineProperty(process, 'version', { value: 'v200.0.0-cache-test' });

  assert.equal((await runCachedTask(fixture)).status, 'built');
  await assertExecutionCount(fixture.rootDir, 2);
});

test('rebuilds when the Node runtime platform changes', async (t) => {
  const fixture = await createFixture(t);
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  t.after(() => Object.defineProperty(process, 'platform', originalDescriptor));
  Object.defineProperty(process, 'platform', { ...originalDescriptor, value: 'cache-platform-a' });
  await primeCache(fixture);
  Object.defineProperty(process, 'platform', { ...originalDescriptor, value: 'cache-platform-b' });

  assert.equal((await runCachedTask(fixture)).status, 'built');
  await assertExecutionCount(fixture.rootDir, 2);
});

test('rebuilds when the Node runtime architecture changes', async (t) => {
  const fixture = await createFixture(t);
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'arch');
  t.after(() => Object.defineProperty(process, 'arch', originalDescriptor));
  Object.defineProperty(process, 'arch', { ...originalDescriptor, value: 'cache-arch-a' });
  await primeCache(fixture);
  Object.defineProperty(process, 'arch', { ...originalDescriptor, value: 'cache-arch-b' });

  assert.equal((await runCachedTask(fixture)).status, 'built');
  await assertExecutionCount(fixture.rootDir, 2);
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

test('ignores added, changed, and removed child-owned outputs while still invalidating owned output changes', async (t) => {
  const fixture = await createFixture(t);
  fixture.task = { ...fixture.task, outputExcludes: ['dist/resources/notify-user'] };
  await primeCache(fixture);

  const childRoot = join(fixture.rootDir, 'dist', 'resources', 'notify-user');
  await mkdir(childRoot, { recursive: true });
  await writeFile(join(childRoot, 'resource.txt'), 'added');
  assert.equal((await runCachedTask(fixture)).status, 'hit');

  await writeFile(join(childRoot, 'resource.txt'), 'changed');
  assert.equal((await runCachedTask(fixture)).status, 'hit');

  await rm(childRoot, { recursive: true, force: true });
  assert.equal((await runCachedTask(fixture)).status, 'hit');

  await writeFile(join(fixture.rootDir, 'dist', 'output.txt'), 'corrupted');
  assert.equal((await runCachedTask(fixture)).status, 'built');
  await assertExecutionCount(fixture.rootDir, 2);
});

test('rebuilds when output ownership exclusions change', async (t) => {
  const fixture = await createFixture(t);
  await primeCache(fixture);
  fixture.task = { ...fixture.task, outputExcludes: ['dist/resources/notify-user'] };

  assert.equal((await runCachedTask(fixture)).status, 'built');
  await assertExecutionCount(fixture.rootDir, 2);
});

test('rejects a successful build when an owned output root has no regular files', async (t) => {
  const fixture = await createFixture(t);
  fixture.task = {
    ...fixture.task,
    command: { file: process.execPath, args: ['-e', emptyOutputCommand] },
  };

  await assert.rejects(
    runCachedTask(fixture),
    /Owned output root must contain at least one regular file: dist/,
  );
  await assert.rejects(readdir(fixture.cacheDir), { code: 'ENOENT' });
});

test('rejects an empty output root reached from an otherwise eligible cache record', async (t) => {
  const fixture = await createFixture(t);
  fixture.task = {
    ...fixture.task,
    command: { file: process.execPath, args: ['-e', conditionalOutputCommand] },
  };
  await writeFile(join(fixture.rootDir, 'produce-output'), 'yes');
  await primeCache(fixture);
  await rm(join(fixture.rootDir, 'produce-output'));
  await rm(join(fixture.rootDir, 'dist', 'output.txt'));

  await assert.rejects(
    runCachedTask(fixture),
    /Owned output root must contain at least one regular file: dist/,
  );
});

test('allows an explicitly empty-capable output root to build and hit the cache', async (t) => {
  const fixture = await createFixture(t);
  fixture.task = {
    ...fixture.task,
    command: { file: process.execPath, args: ['-e', emptyOutputCommand] },
    emptyOutputs: ['dist'],
  };

  assert.equal((await runCachedTask(fixture)).status, 'built');
  assert.equal((await runCachedTask(fixture)).status, 'hit');
  await assertExecutionCount(fixture.rootDir, 1);
});

test('includes canonical empty-output allowances in the task digest', async (t) => {
  const fixture = await createFixture(t);
  await primeCache(fixture);
  fixture.task = { ...fixture.task, emptyOutputs: ['dist/.'] };

  assert.equal((await runCachedTask(fixture)).status, 'built');
  await assertExecutionCount(fixture.rootDir, 2);
});

test('rejects unsafe and undeclared empty-output allowances', async (t) => {
  const fixture = await createFixture(t);

  await assert.rejects(
    runCachedTask({
      ...fixture,
      task: { ...fixture.task, emptyOutputs: [join(fixture.rootDir, 'dist')] },
    }),
    /Empty-output allowance must be repository-relative:/,
  );
  await assert.rejects(
    runCachedTask({
      ...fixture,
      task: { ...fixture.task, emptyOutputs: ['dist/../other'] },
    }),
    /Empty-output allowance must exactly match a declared output root: dist\/\.\.\/other/,
  );
});

test('rejects an output exclusion outside every declared output root', async (t) => {
  const fixture = await createFixture(t);
  fixture.task = { ...fixture.task, outputExcludes: ['other-task/dist'] };

  await assert.rejects(
    runCachedTask(fixture),
    /Output exclusion must be inside a declared output root: other-task\/dist/,
  );
});

test('rejects an output exclusion equal to a declared output root', async (t) => {
  const fixture = await createFixture(t);
  fixture.task = { ...fixture.task, outputExcludes: ['dist'] };

  await assert.rejects(
    runCachedTask(fixture),
    /Output exclusion must be inside a declared output root: dist/,
  );
});

test('canonicalizes output exclusion order before calculating the task digest', async (t) => {
  const fixture = await createFixture(t);
  fixture.task = {
    ...fixture.task,
    outputExcludes: ['dist/resources/second', 'dist/resources/first'],
  };
  await primeCache(fixture);
  fixture.task = {
    ...fixture.task,
    outputExcludes: ['dist/resources/first', 'dist/resources/second'],
  };

  assert.equal((await runCachedTask(fixture)).status, 'hit');
  await assertExecutionCount(fixture.rootDir, 1);
});

test('rejects an absolute output exclusion path', async (t) => {
  const fixture = await createFixture(t);
  fixture.task = { ...fixture.task, outputExcludes: [join(fixture.rootDir, 'dist', 'resources')] };

  await assert.rejects(
    runCachedTask(fixture),
    /Output exclusion must be repository-relative:/,
  );
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

test('does not hash stale outputs before definite cache misses', async (t) => {
  for (const missKind of [
    'absent record',
    'malformed record',
    'incompatible record',
    'corrupted result digest',
    'incorrect result digest',
    'changed input',
    'force',
  ]) {
    await t.test(missKind, async (t) => {
      const fixture = await createFixture(t);
      fixture.task = {
        ...fixture.task,
        command: { file: process.execPath, args: ['-e', replaceOutputCommand] },
      };

      if (missKind === 'absent record') {
        await mkdir(join(fixture.rootDir, 'dist'), { recursive: true });
        await writeFile(join(fixture.rootDir, 'dist', 'output.txt'), 'stale');
      } else {
        await primeCache(fixture);
        if (missKind === 'malformed record') {
          await writeFile(await cacheRecordPath(fixture.cacheDir), '{not json');
        } else if (missKind === 'incompatible record') {
          const recordPath = await cacheRecordPath(fixture.cacheDir);
          const record = JSON.parse(await readFile(recordPath, 'utf8'));
          await writeFile(recordPath, JSON.stringify({ ...record, schemaVersion: 999 }));
        } else if (missKind === 'corrupted result digest') {
          const recordPath = await cacheRecordPath(fixture.cacheDir);
          const record = JSON.parse(await readFile(recordPath, 'utf8'));
          await writeFile(recordPath, JSON.stringify({ ...record, resultDigest: 'corrupted' }));
        } else if (missKind === 'incorrect result digest') {
          const recordPath = await cacheRecordPath(fixture.cacheDir);
          const record = JSON.parse(await readFile(recordPath, 'utf8'));
          await writeFile(recordPath, JSON.stringify({ ...record, resultDigest: '0'.repeat(64) }));
        } else if (missKind === 'changed input') {
          await writeFile(join(fixture.rootDir, 'src', 'input.txt'), 'changed');
        }
      }

      await chmod(join(fixture.rootDir, 'dist', 'output.txt'), 0o000);
      const result = await runCachedTask({ ...fixture, force: missKind === 'force' });
      assert.equal(result.status, 'built');
    });
  }
});

test('rebuilds when the existing cache record has a corrupted result digest', async (t) => {
  const fixture = await createFixture(t);
  await primeCache(fixture);
  const recordPath = await cacheRecordPath(fixture.cacheDir);
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  await writeFile(recordPath, JSON.stringify({ ...record, resultDigest: '0'.repeat(64) }));

  const result = await runCachedTask(fixture);
  assert.equal(result.status, 'built');
  assert.notEqual(result.resultDigest, '0'.repeat(64));
  await assertExecutionCount(fixture.rootDir, 2);
});

test('force rebuilds an otherwise valid cache hit', async (t) => {
  const fixture = await createFixture(t);
  await primeCache(fixture);

  assert.equal((await runCachedTask({ ...fixture, force: true })).status, 'built');
  await assertExecutionCount(fixture.rootDir, 2);
});

test('leaves a previous successful record byte-for-byte unchanged after a failing rebuild', async (t) => {
  const fixture = await createFixture(t);
  await primeCache(fixture);
  const recordPath = await cacheRecordPath(fixture.cacheDir);
  const successfulRecord = await readFile(recordPath);
  await writeFile(join(fixture.rootDir, 'src', 'input.txt'), 'changed');
  fixture.task = {
    ...fixture.task,
    command: { file: process.execPath, args: ['-e', 'process.exit(7)'] },
  };

  await assert.rejects(runCachedTask(fixture), (error) => error.status === 7);
  assert.deepEqual(await readFile(recordPath), successfulRecord);
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
  return { rootDir, cacheDir: join(rootDir, '.cache', 'harbors-build', 'v1'), task: createFixtureTask(), ...options };
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
