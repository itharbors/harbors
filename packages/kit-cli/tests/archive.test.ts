import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  truncate,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import yauzl from 'yauzl';
import { ZipFile } from 'yazl';

import { inspectKit, packKit } from '../src/index.js';

const fixtureDirectory = path.resolve(import.meta.dirname, 'fixtures/minimal-kit');
const temporaryDirectories: string[] = [];
const openZip = promisify(yauzl.open);

interface TestZipEntry {
  name: string;
  data?: Buffer | string;
  mode?: number;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harbors-kit-archive-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeZip(file: string, entries: TestZipEntry[]): Promise<void> {
  const zip = new ZipFile();
  const output = createWriteStream(file);
  zip.outputStream.pipe(output);
  for (const entry of entries) {
    zip.addBuffer(
      Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? ''),
      entry.name,
      {
        mtime: new Date('1980-01-01T00:00:00.000Z'),
        mode: entry.mode ?? 0o100644,
      },
    );
  }
  zip.end();
  await finished(output);
}

function replaceAllBytes(input: Buffer, from: string, replacement: Buffer): Buffer {
  const output = Buffer.from(input);
  const needle = Buffer.from(from);
  expect(replacement.length).toBe(needle.length);
  let offset = 0;
  let replacements = 0;
  while ((offset = output.indexOf(needle, offset)) !== -1) {
    replacement.copy(output, offset);
    offset += replacement.length;
    replacements += 1;
  }
  expect(replacements).toBeGreaterThanOrEqual(2);
  return output;
}

function patchCentralUncompressedSizes(input: Buffer, sizes: number[]): Buffer {
  const output = Buffer.from(input);
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  let offset = 0;
  let index = 0;
  while ((offset = output.indexOf(signature, offset)) !== -1) {
    if (index < sizes.length) output.writeUInt32LE(sizes[index], offset + 24);
    index += 1;
    offset += 4;
  }
  expect(index).toBe(sizes.length);
  return output;
}

async function listEntries(file: string): Promise<Array<{
  name: string;
  date: Date;
  mode: number;
}>> {
  const zip = await openZip(file, { lazyEntries: true }) as yauzl.ZipFile;
  return await new Promise((resolve, reject) => {
    const entries: Array<{ name: string; date: Date; mode: number }> = [];
    zip.on('entry', (entry) => {
      entries.push({
        name: entry.fileName,
        date: entry.getLastModDate(),
        mode: entry.externalFileAttributes >>> 16,
      });
      zip.readEntry();
    });
    zip.once('end', () => resolve(entries));
    zip.once('error', reject);
    zip.readEntry();
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('packKit', () => {
  it('packs identical Kit projects into byte-identical archives', async () => {
    const directory = await temporaryDirectory();
    const first = await packKit({ directory: fixtureDirectory, output: path.join(directory, 'a.hkit') });
    const second = await packKit({ directory: fixtureDirectory, output: path.join(directory, 'b.hkit') });

    expect(first.sha256).toBe(second.sha256);
    expect(await readFile(first.output)).toEqual(await readFile(second.output));
  });

  it('writes lexicographically ordered regular files with a fixed timestamp and mode', async () => {
    const directory = await temporaryDirectory();
    const packed = await packKit({ directory: fixtureDirectory, output: path.join(directory, 'kit.hkit') });
    const entries = await listEntries(packed.output);

    expect(entries.map((entry) => entry.name)).toEqual(
      [...entries.map((entry) => entry.name)].sort((left, right) => left.localeCompare(right)),
    );
    expect(entries.every((entry) => entry.date.toISOString() === '1980-01-01T00:00:00.000Z')).toBe(true);
    expect(entries.every((entry) => (entry.mode & 0o170000) === 0o100000)).toBe(true);
    expect(entries.every((entry) => (entry.mode & 0o777) === 0o644)).toBe(true);
  });

  it('checksums every payload file plus the SBOM but not checksums.json itself', async () => {
    const directory = await temporaryDirectory();
    const packed = await packKit({ directory: fixtureDirectory, output: path.join(directory, 'kit.hkit') });
    const inspected = await inspectKit({ archive: packed.output });

    expect(inspected.checksums.map((entry) => entry.path)).toEqual([
      'kit.json',
      'layout.json',
      'main.html',
      'package.json',
      'plugins/demo/main/dist/index.js',
      'plugins/demo/package.json',
      'plugins/demo/panel.main/dist/index.html',
      'sbom.spdx.json',
      'secondary.html',
    ]);
    expect(inspected.checksums.some((entry) => entry.path === 'checksums.json')).toBe(false);
  });

  it('inspects identity, counts, sizes, and the whole-archive digest', async () => {
    const directory = await temporaryDirectory();
    const packed = await packKit({ directory: fixtureDirectory, output: path.join(directory, 'kit.hkit') });
    const inspected = await inspectKit({ archive: packed.output });

    expect(inspected.manifest.id).toBe('@example/kit-demo');
    expect(inspected.files).toBe(10);
    expect(inspected.compressedSize).toBe((await stat(packed.output)).size);
    expect(inspected.uncompressedSize).toBeGreaterThan(0);
    expect(inspected.sha256).toBe(packed.sha256);
  });
});

describe('inspectKit archive boundaries', () => {
  it.each([
    ['absolute', 'xabs.txt', Buffer.from('/abs.txt')],
    ['parent traversal', 'aa/file', Buffer.from('../file')],
    ['backslash', 'aa/file', Buffer.from('aa\\file')],
    ['NUL', 'nul.txt', Buffer.from([0x6e, 0x75, 0x00, 0x2e, 0x74, 0x78, 0x74])],
  ])('rejects an unsafe %s entry path', async (_label, safeName, unsafeName) => {
    const directory = await temporaryDirectory();
    const archive = path.join(directory, 'unsafe.hkit');
    await writeZip(archive, [{ name: safeName, data: 'value' }]);
    await writeFile(archive, replaceAllBytes(await readFile(archive), safeName, unsafeName));

    await expect(inspectKit({ archive })).rejects.toThrow(/path|file name|filename/i);
  });

  it('rejects duplicate and case-folded duplicate paths', async () => {
    const directory = await temporaryDirectory();
    const duplicate = path.join(directory, 'duplicate.hkit');
    const folded = path.join(directory, 'folded.hkit');
    await writeZip(duplicate, [
      { name: 'same.txt', data: 'a' },
      { name: 'same.txt', data: 'b' },
    ]);
    await writeZip(folded, [
      { name: 'FILE.txt', data: 'a' },
      { name: 'file.txt', data: 'b' },
    ]);

    await expect(inspectKit({ archive: duplicate })).rejects.toThrow(/duplicate archive path/i);
    await expect(inspectKit({ archive: folded })).rejects.toThrow(/case-folded duplicate/i);
  });

  it('rejects symbolic-link Unix modes', async () => {
    const directory = await temporaryDirectory();
    const archive = path.join(directory, 'symlink.hkit');
    await writeZip(archive, [{ name: 'link', data: 'target', mode: 0o120777 }]);

    await expect(inspectKit({ archive })).rejects.toThrow(/symbolic link|file type/i);
  });

  it('rejects an entry larger than 256 MiB from central-directory metadata', async () => {
    const directory = await temporaryDirectory();
    const archive = path.join(directory, 'large-entry.hkit');
    await writeZip(archive, [{ name: 'large.bin' }]);
    await writeFile(
      archive,
      patchCentralUncompressedSizes(await readFile(archive), [256 * 1024 * 1024 + 1]),
    );

    await expect(inspectKit({ archive })).rejects.toThrow(/entry.*256 MiB/i);
  });

  it('rejects more than 10,000 entries', async () => {
    const directory = await temporaryDirectory();
    const archive = path.join(directory, 'too-many.hkit');
    await writeZip(archive, Array.from({ length: 10_001 }, (_, index) => ({
      name: `files/${String(index).padStart(5, '0')}.txt`,
    })));

    await expect(inspectKit({ archive })).rejects.toThrow(/10,000 entries/i);
  });

  it('rejects more than 1 GiB of declared uncompressed data', async () => {
    const directory = await temporaryDirectory();
    const archive = path.join(directory, 'zip-bomb.hkit');
    await writeZip(archive, Array.from({ length: 5 }, (_, index) => ({ name: `f${index}.bin` })));
    await writeFile(
      archive,
      patchCentralUncompressedSizes(
        await readFile(archive),
        Array.from({ length: 5 }, () => 256 * 1024 * 1024),
      ),
    );

    await expect(inspectKit({ archive })).rejects.toThrow(/1 GiB/i);
  });

  it('rejects an outer archive larger than 512 MiB before ZIP parsing', async () => {
    const directory = await temporaryDirectory();
    const archive = path.join(directory, 'outer-too-large.hkit');
    await writeFile(archive, 'not-a-zip');
    await truncate(archive, 512 * 1024 * 1024 + 1);

    await expect(inspectKit({ archive })).rejects.toThrow(/512 MiB/i);
  });

  it('rejects payload bytes that disagree with checksums.json', async () => {
    const directory = await temporaryDirectory();
    const archive = path.join(directory, 'bad-checksum.hkit');
    const kitJson = await readFile(path.join(fixtureDirectory, 'kit.json'));
    const sbom = Buffer.from('{}\n');
    const payload = Buffer.from('changed payload');
    const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
    const checksums = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      files: [
        { path: 'kit.json', sha256: digest(kitJson), size: kitJson.length },
        { path: 'payload.txt', sha256: '0'.repeat(64), size: payload.length },
        { path: 'sbom.spdx.json', sha256: digest(sbom), size: sbom.length },
      ],
    }, null, 2)}\n`);
    await writeZip(archive, [
      { name: 'checksums.json', data: checksums },
      { name: 'kit.json', data: kitJson },
      { name: 'payload.txt', data: payload },
      { name: 'sbom.spdx.json', data: sbom },
    ]);

    await expect(inspectKit({ archive })).rejects.toThrow(/checksum mismatch.*payload\.txt/i);
  });
});
