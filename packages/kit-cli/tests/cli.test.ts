import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../src/cli.js';

const fixtureDirectory = path.resolve(import.meta.dirname, 'fixtures/minimal-kit');
const temporaryDirectories: string[] = [];

function captureIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: { write(value: string) { stdout += value; } },
      stderr: { write(value: string) { stderr += value; } },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('runCli', () => {
  it('validates and packs with stable KEY=value output', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'harbors-kit-cli-'));
    temporaryDirectories.push(directory);
    const output = path.join(directory, 'demo.hkit');
    const validateIo = captureIo();
    const packIo = captureIo();

    await expect(runCli(['validate', fixtureDirectory], validateIo.io)).resolves.toBe(0);
    expect(validateIo.stderr()).toBe('');
    expect(validateIo.stdout()).toBe(
      'KIT_ID=@example/kit-demo\nKIT_VERSION=1.2.3\nFILES=8\n',
    );

    await expect(runCli(['pack', fixtureDirectory, '--output', output], packIo.io)).resolves.toBe(0);
    expect(packIo.stderr()).toBe('');
    expect(packIo.stdout()).toMatch(
      new RegExp(`^KIT_ID=@example/kit-demo\\nKIT_VERSION=1\\.2\\.3\\nOUTPUT=${output.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\nSHA256=[a-f0-9]{64}\\nSIZE=\\d+\\nFILES=10\\n$`),
    );
  });

  it('inspects an archive as canonical JSON', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'harbors-kit-cli-'));
    temporaryDirectories.push(directory);
    const output = path.join(directory, 'demo.hkit');
    expect(await runCli(['pack', fixtureDirectory, '--output', output], captureIo().io)).toBe(0);
    const inspectIo = captureIo();

    await expect(runCli(['inspect', output, '--json'], inspectIo.io)).resolves.toBe(0);
    const parsed = JSON.parse(inspectIo.stdout());
    expect(parsed.manifest.id).toBe('@example/kit-demo');
    expect(parsed.files).toBe(10);
    expect(inspectIo.stdout().endsWith('\n')).toBe(true);
    expect(inspectIo.stderr()).toBe('');
  });

  it('returns 2 for usage errors and 1 for validation errors', async () => {
    const usageIo = captureIo();
    const validationIo = captureIo();

    await expect(runCli(['unknown'], usageIo.io)).resolves.toBe(2);
    expect(usageIo.stderr()).toMatch(/Usage:/);
    await expect(runCli(['validate', '/definitely/missing'], validationIo.io)).resolves.toBe(1);
    expect(validationIo.stderr()).toMatch(/^ERROR=/);
  });
});
