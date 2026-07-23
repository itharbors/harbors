import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  mkdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  normalizeArchivePath,
  parseKitPackageManifest,
  type KitPackageManifest,
} from '@itharbors/kit-core';
import yauzl, { type Entry, type ZipFile as ReadZipFile } from 'yauzl';
import { ZipFile } from 'yazl';

import { canonicalJson, sha256File } from './checksums.js';
import { validateKit } from './kit-project.js';
import { buildSpdx } from './sbom.js';

const ZIP_DATE = new Date('1980-01-01T00:00:00.000Z');
const ZIP_FILE_MODE = 0o100644;
const MAX_ENTRIES = 10_000;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const METADATA_PATHS = new Set(['kit.json', 'checksums.json', 'sbom.spdx.json']);
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;

let temporarySequence = 0;

export interface KitChecksumEntry {
  path: string;
  sha256: string;
  size: number;
}

interface KitChecksums {
  schemaVersion: 1;
  files: KitChecksumEntry[];
}

export interface PackedKit {
  id: string;
  version: string;
  output: string;
  sha256: string;
  size: number;
  files: number;
}

export interface InspectedKit {
  manifest: KitPackageManifest;
  files: number;
  compressedSize: number;
  uncompressedSize: number;
  sha256: string;
  checksums: KitChecksumEntry[];
}

interface ArchiveEntrySource {
  archivePath: string;
  file?: string;
  buffer?: Buffer;
}

interface ObservedEntry {
  size: number;
  sha256: string;
}

function digestBuffer(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function packKit({
  directory,
  output,
}: {
  directory: string;
  output: string;
}): Promise<PackedKit> {
  const project = await validateKit(directory);
  for (const reserved of METADATA_PATHS) {
    if (reserved !== 'kit.json' && project.payload.some((file) => file.archivePath === reserved)) {
      throw new Error(`Kit payload must not define reserved archive path ${reserved}`);
    }
  }

  const payloadChecksums = await Promise.all(project.payload.map(async (file) => ({
    path: file.archivePath,
    sha256: await sha256File(file.absolutePath),
    size: file.size,
  })));
  const sbomBuffer = Buffer.from(canonicalJson(await buildSpdx(project)));
  const checksums: KitChecksums = {
    schemaVersion: 1,
    files: [...payloadChecksums, {
      path: 'sbom.spdx.json',
      sha256: digestBuffer(sbomBuffer),
      size: sbomBuffer.length,
    }].sort((left, right) => left.path.localeCompare(right.path)),
  };
  const checksumsBuffer = Buffer.from(canonicalJson(checksums));
  const entries: ArchiveEntrySource[] = [
    ...project.payload.map((file) => ({
      archivePath: file.archivePath,
      file: file.absolutePath,
    })),
    { archivePath: 'checksums.json', buffer: checksumsBuffer },
    { archivePath: 'sbom.spdx.json', buffer: sbomBuffer },
  ].sort((left, right) => left.archivePath.localeCompare(right.archivePath));

  const outputPath = path.resolve(output);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${temporarySequence += 1}`;
  const zip = new ZipFile();
  try {
    for (const entry of entries) {
      const options = { mtime: ZIP_DATE, mode: ZIP_FILE_MODE, compress: true };
      if (entry.file !== undefined) {
        zip.addFile(entry.file, entry.archivePath, options);
      } else {
        zip.addBuffer(entry.buffer!, entry.archivePath, options);
      }
    }
    const outputStream = createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 });
    const transfer = pipeline(zip.outputStream as unknown as Readable, outputStream);
    zip.end();
    await transfer;
    await rename(temporaryPath, outputPath);
  } catch (error) {
    (zip.outputStream as unknown as Readable).destroy();
    await rm(temporaryPath, { force: true });
    throw error;
  }

  const outputInfo = await stat(outputPath);
  return {
    id: project.manifest.id,
    version: project.manifest.version,
    output: outputPath,
    sha256: await sha256File(outputPath),
    size: outputInfo.size,
    files: entries.length,
  };
}

function openZip(file: string): Promise<ReadZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, {
      autoClose: false,
      lazyEntries: true,
      strictFileNames: true,
      validateEntrySizes: true,
    }, (error, zip) => {
      if (error) reject(error);
      else resolve(zip!);
    });
  });
}

function openEntryStream(zip: ReadZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) reject(error);
      else resolve(stream!);
    });
  });
}

async function readEntry(
  zip: ReadZipFile,
  entry: Entry,
  buffer: boolean,
): Promise<{ digest: string; buffer?: Buffer }> {
  const stream = await openEntryStream(zip, entry);
  const hash = createHash('sha256');
  const chunks: Buffer[] = [];
  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    hash.update(chunk);
    if (buffer) chunks.push(chunk);
  }
  return {
    digest: hash.digest('hex'),
    ...(buffer ? { buffer: Buffer.concat(chunks) } : {}),
  };
}

function parseChecksums(value: unknown): KitChecksums {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('checksums.json must be an object');
  }
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).find((key) => !['schemaVersion', 'files'].includes(key));
  if (unknown) throw new Error(`checksums.json contains unexpected field ${unknown}`);
  if (input.schemaVersion !== 1) throw new Error('checksums.json schemaVersion must equal 1');
  if (!Array.isArray(input.files)) throw new Error('checksums.json files must be an array');

  const paths = new Set<string>();
  const files = input.files.map((rawFile, index): KitChecksumEntry => {
    if (rawFile === null || typeof rawFile !== 'object' || Array.isArray(rawFile)) {
      throw new Error(`checksums.json files[${index}] must be an object`);
    }
    const file = rawFile as Record<string, unknown>;
    const unknownField = Object.keys(file).find((key) => !['path', 'sha256', 'size'].includes(key));
    if (unknownField) {
      throw new Error(`checksums.json files[${index}] contains unexpected field ${unknownField}`);
    }
    if (typeof file.path !== 'string') {
      throw new Error(`checksums.json files[${index}] has an invalid path`);
    }
    const filePath = normalizeArchivePath(file.path);
    if (filePath === 'checksums.json') {
      throw new Error('checksums.json must not checksum itself');
    }
    if (paths.has(filePath)) throw new Error(`checksums.json contains duplicate path ${filePath}`);
    paths.add(filePath);
    if (typeof file.sha256 !== 'string' || !CHECKSUM_PATTERN.test(file.sha256)) {
      throw new Error(`checksums.json files[${index}] has an invalid SHA-256 digest`);
    }
    if (!Number.isSafeInteger(file.size) || (file.size as number) < 0) {
      throw new Error(`checksums.json files[${index}] has an invalid size`);
    }
    return { path: filePath, sha256: file.sha256, size: file.size as number };
  });
  return { schemaVersion: 1, files };
}

async function collectArchive(zip: ReadZipFile): Promise<{
  count: number;
  uncompressedSize: number;
  observed: Map<string, ObservedEntry>;
  metadata: Map<string, Buffer>;
}> {
  let count = 0;
  let uncompressedSize = 0;
  const paths = new Set<string>();
  const caseFoldedPaths = new Set<string>();
  const observed = new Map<string, ObservedEntry>();
  const metadata = new Map<string, Buffer>();
  const entries: Array<{ entry: Entry; entryPath: string; isMetadata: boolean }> = [];

  return await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(error);
    };
    zip.once('error', fail);
    zip.once('end', () => {
      void (async () => {
        for (const { entry, entryPath, isMetadata } of entries) {
          const result = await readEntry(zip, entry, isMetadata);
          observed.set(entryPath, { size: entry.uncompressedSize, sha256: result.digest });
          if (result.buffer !== undefined) metadata.set(entryPath, result.buffer);
        }
        if (settled) return;
        settled = true;
        zip.close();
        resolve({ count, uncompressedSize, observed, metadata });
      })().catch(fail);
    });
    zip.on('entry', (entry) => {
      try {
        count += 1;
        if (count > MAX_ENTRIES) {
          throw new Error('Kit archive exceeds the 10,000 entries limit');
        }
        const entryPath = normalizeArchivePath(entry.fileName);
        if (paths.has(entryPath)) throw new Error(`Duplicate archive path: ${entryPath}`);
        paths.add(entryPath);
        const folded = entryPath.toLocaleLowerCase('en-US');
        if (caseFoldedPaths.has(folded)) {
          throw new Error(`Case-folded duplicate archive path: ${entryPath}`);
        }
        caseFoldedPaths.add(folded);

        const mode = entry.externalFileAttributes >>> 16;
        const fileType = mode & 0o170000;
        if (fileType !== 0 && fileType !== 0o100000) {
          throw new Error(`Archive entry ${entryPath} has a forbidden symbolic link or device file type`);
        }
        if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
          throw new Error(`Archive entry ${entryPath} exceeds the 256 MiB entry limit`);
        }
        uncompressedSize += entry.uncompressedSize;
        if (uncompressedSize > MAX_UNCOMPRESSED_BYTES) {
          throw new Error('Kit archive exceeds the 1 GiB uncompressed data limit');
        }
        const isMetadata = METADATA_PATHS.has(entryPath);
        if (isMetadata && entry.uncompressedSize > MAX_METADATA_BYTES) {
          throw new Error(`Archive metadata ${entryPath} exceeds 1 MiB`);
        }
        entries.push({ entry, entryPath, isMetadata });
        zip.readEntry();
      } catch (error) {
        fail(error);
      }
    });
    zip.readEntry();
  });
}

export async function inspectKit({ archive }: { archive: string }): Promise<InspectedKit> {
  const archivePath = path.resolve(archive);
  const archiveInfo = await stat(archivePath);
  if (!archiveInfo.isFile()) throw new Error('Kit archive must be a regular file');
  if (archiveInfo.size > MAX_ARCHIVE_BYTES) {
    throw new Error('Kit archive exceeds the 512 MiB compressed input limit');
  }

  const zip = await openZip(archivePath);
  const { count, uncompressedSize, observed, metadata } = await collectArchive(zip);
  for (const required of METADATA_PATHS) {
    if (!metadata.has(required)) throw new Error(`Kit archive is missing ${required}`);
  }

  let manifestValue: unknown;
  let checksumsValue: unknown;
  try {
    manifestValue = JSON.parse(metadata.get('kit.json')!.toString('utf8'));
  } catch {
    throw new Error('kit.json is not valid JSON');
  }
  try {
    checksumsValue = JSON.parse(metadata.get('checksums.json')!.toString('utf8'));
  } catch {
    throw new Error('checksums.json is not valid JSON');
  }
  try {
    const spdx = JSON.parse(metadata.get('sbom.spdx.json')!.toString('utf8')) as unknown;
    if (spdx === null || typeof spdx !== 'object' || Array.isArray(spdx)) {
      throw new Error('not an object');
    }
  } catch {
    throw new Error('sbom.spdx.json is not valid JSON metadata');
  }

  const manifest = parseKitPackageManifest(manifestValue);
  const checksums = parseChecksums(checksumsValue);
  if (checksums.files.length !== observed.size - 1) {
    throw new Error('checksums.json does not describe every archive payload entry');
  }
  for (const expected of checksums.files) {
    const actual = observed.get(expected.path);
    if (!actual) throw new Error(`checksums.json references missing path ${expected.path}`);
    if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
      throw new Error(`Internal checksum mismatch for ${expected.path}`);
    }
  }
  for (const entryPath of observed.keys()) {
    if (entryPath === 'checksums.json') continue;
    if (!checksums.files.some((expected) => expected.path === entryPath)) {
      throw new Error(`Archive entry ${entryPath} is missing from checksums.json`);
    }
  }

  return {
    manifest,
    files: count,
    compressedSize: archiveInfo.size,
    uncompressedSize,
    sha256: await sha256File(archivePath),
    checksums: checksums.files,
  };
}
