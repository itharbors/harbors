import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildSpdx, canonicalJson, sha256File, validateKit } from '../src/index.js';

const fixtureDirectory = path.resolve(import.meta.dirname, 'fixtures/minimal-kit');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('canonicalJson', () => {
  it('sorts object keys recursively, preserves arrays, and appends one newline', () => {
    expect(canonicalJson({ z: 1, nested: { b: 2, a: 1 }, list: [{ y: 2, x: 1 }] })).toBe(
      '{\n'
      + '  "list": [\n'
      + '    {\n'
      + '      "x": 1,\n'
      + '      "y": 2\n'
      + '    }\n'
      + '  ],\n'
      + '  "nested": {\n'
      + '    "a": 1,\n'
      + '    "b": 2\n'
      + '  },\n'
      + '  "z": 1\n'
      + '}\n',
    );
  });
});

describe('sha256File', () => {
  it('streams a file into its lowercase SHA-256 digest', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'harbors-kit-sha-'));
    temporaryDirectories.push(directory);
    const file = path.join(directory, 'value.txt');
    await writeFile(file, 'abc');

    await expect(sha256File(file)).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('buildSpdx', () => {
  it('emits deterministic SPDX 2.3 metadata with sorted package names', async () => {
    const project = await validateKit(fixtureDirectory);

    const first = await buildSpdx(project);
    const second = await buildSpdx(project);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      spdxVersion: 'SPDX-2.3',
      dataLicense: 'CC0-1.0',
      SPDXID: 'SPDXRef-DOCUMENT',
      name: '@example/kit-demo@1.2.3',
    });
    expect(first.documentNamespace).toMatch(
      /^https:\/\/itharbors\.dev\/spdx\/[A-Za-z0-9_-]+\/1\.2\.3\/[a-f0-9]{64}$/,
    );
    expect(first.packages.map((pkg: { name: string }) => pkg.name)).toEqual([
      '@example/demo',
      '@example/kit-demo',
    ]);
  });
});
