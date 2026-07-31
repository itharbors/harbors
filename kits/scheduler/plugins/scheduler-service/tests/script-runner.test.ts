import { access, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createScriptRunner } from '../main/src/script-runner';

const roots: string[] = [];
const runners: Array<ReturnType<typeof createScriptRunner>> = [];

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.dispose()));
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Node script runner', () => {
  it('runs the real Node entry without a shell and uses its directory as cwd', async () => {
    const { root, script } = await createScript(`
      console.log(JSON.stringify({
        cwd: process.cwd(),
        value: process.env.HARBORS_SCHEDULER_TEST_VALUE
      }));
    `);
    process.env.HARBORS_SCHEDULER_TEST_VALUE = 'inherited';
    const runner = createRunner();

    const result = await runner.run('run-1', script);

    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(JSON.parse(result.stdout)).toEqual({
      cwd: await realpath(root),
      value: 'inherited',
    });
    expect(result.stderr).toBe('');
    delete process.env.HARBORS_SCHEDULER_TEST_VALUE;
  });

  it('returns non-zero exits and stderr as execution results', async () => {
    const { script } = await createScript(`
      console.error('broken');
      process.exitCode = 7;
    `);
    const runner = createRunner();

    await expect(runner.run('run-2', script)).resolves.toMatchObject({
      exitCode: 7,
      signal: null,
      stderr: 'broken\n',
    });
  });

  it('keeps only the configured tail of stdout and stderr', async () => {
    const { script } = await createScript(`
      process.stdout.write('a'.repeat(80_000) + 'STDOUT_END');
      process.stderr.write('b'.repeat(80_000) + 'STDERR_END');
    `);
    const runner = createRunner();

    const result = await runner.run('run-tail', script);

    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(65_536);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(65_536);
    expect(result.stdout.endsWith('STDOUT_END')).toBe(true);
    expect(result.stderr.endsWith('STDERR_END')).toBe(true);
  });

  it('terminates an active child and waits for its exit', async () => {
    const root = await createRoot();
    const marker = path.join(root, 'started');
    const script = path.join(root, 'long-running.mjs');
    await writeFile(script, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(marker)}, 'started');
      setInterval(() => {}, 1000);
    `);
    const runner = createRunner();
    const running = runner.run('run-long', script);
    await waitForFile(marker);

    await runner.terminate('run-long');

    const result = await running;
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe('SIGTERM');
    await expect(readFile(marker, 'utf8')).resolves.toBe('started');
  });
});

function createRunner() {
  const runner = createScriptRunner();
  runners.push(runner);
  return runner;
}

async function createScript(source: string) {
  const root = await createRoot();
  const script = path.join(root, 'script.mjs');
  await writeFile(script, source);
  return { root, script };
}

async function createRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-script-runner-'));
  roots.push(root);
  return root;
}

async function waitForFile(filePath: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}
