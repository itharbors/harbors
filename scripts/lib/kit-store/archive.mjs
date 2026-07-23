import { createHash } from 'node:crypto';
import { mkdir, open, stat } from 'node:fs/promises';
import path from 'node:path';
import yauzl from 'yauzl';

import { normalizeArchivePath, parseKitPackageManifest } from '@itharbors/kit-core';

const MAX_ENTRIES = 10_000;
const MAX_ENTRY = 256 * 1024 * 1024;
const MAX_TOTAL = 1024 * 1024 * 1024;
const MAX_METADATA = 1024 * 1024;

function openZip(file) {
  return new Promise((resolve, reject) => yauzl.open(file, {
    lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true,
  }, (error, zip) => error ? reject(error) : resolve(zip)));
}

function streamFor(zip, entry) {
  return new Promise((resolve, reject) => zip.openReadStream(
    entry, (error, stream) => error ? reject(error) : resolve(stream),
  ));
}

async function scan(zip) {
  return new Promise((resolve, reject) => {
    const entries = [];
    const paths = new Set();
    const folded = new Set();
    let total = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(error);
    };
    zip.once('error', fail);
    zip.once('end', () => {
      if (settled) return;
      settled = true;
      resolve(entries);
    });
    zip.on('entry', (entry) => {
      try {
        if (entries.length >= MAX_ENTRIES) throw new Error('Archive exceeds 10,000 entries');
        const archivePath = normalizeArchivePath(entry.fileName);
        if (paths.has(archivePath)) throw new Error(`Duplicate archive path: ${archivePath}`);
        paths.add(archivePath);
        const key = archivePath.toLocaleLowerCase('en-US');
        if (folded.has(key)) throw new Error(`Case-folded duplicate archive path: ${archivePath}`);
        folded.add(key);
        const type = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (type !== 0 && type !== 0o100000) throw new Error(`Forbidden archive file type: ${archivePath}`);
        if (entry.uncompressedSize > MAX_ENTRY) throw new Error(`Archive entry exceeds 256 MiB: ${archivePath}`);
        total += entry.uncompressedSize;
        if (total > MAX_TOTAL) throw new Error('Archive exceeds 1 GiB uncompressed data');
        entries.push({ entry, archivePath });
        zip.readEntry();
      } catch (error) {
        fail(error);
      }
    });
    zip.readEntry();
  });
}

async function readBuffer(zip, entry) {
  if (entry.uncompressedSize > MAX_METADATA) throw new Error('Archive metadata exceeds 1 MiB');
  const chunks = [];
  for await (const chunk of await streamFor(zip, entry)) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function parseChecksums(buffer) {
  const value = JSON.parse(buffer.toString('utf8'));
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.files)) {
    throw new Error('Invalid checksums.json');
  }
  const result = new Map();
  for (const file of value.files) {
    const filePath = normalizeArchivePath(file?.path);
    if (!/^[a-f0-9]{64}$/u.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0) {
      throw new Error(`Invalid checksum entry: ${filePath}`);
    }
    if (result.has(filePath)) throw new Error(`Duplicate checksum path: ${filePath}`);
    result.set(filePath, file);
  }
  return result;
}

export async function extractVerifiedArchive({ archivePath, destination }) {
  if ((await stat(archivePath)).size > 512 * 1024 * 1024) {
    throw new Error('Archive exceeds 512 MiB compressed input');
  }
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const zip = await openZip(archivePath);
  try {
    const entries = await scan(zip);
    const byPath = new Map(entries.map((value) => [value.archivePath, value]));
    for (const required of ['kit.json', 'checksums.json', 'sbom.spdx.json']) {
      if (!byPath.has(required)) throw new Error(`Archive is missing ${required}`);
    }
    const checksums = parseChecksums(await readBuffer(zip, byPath.get('checksums.json').entry));
    if (checksums.size !== entries.length - 1) throw new Error('checksums.json does not cover every file');
    let kitBuffer;
    for (const { entry, archivePath: entryPath } of entries) {
      const outputPath = path.join(destination, ...entryPath.split('/'));
      await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
      const handle = await open(outputPath, 'wx', 0o600);
      const hash = createHash('sha256');
      const chunks = entryPath === 'kit.json' ? [] : null;
      let size = 0;
      try {
        for await (const raw of await streamFor(zip, entry)) {
          const chunk = Buffer.from(raw);
          size += chunk.length;
          hash.update(chunk);
          if (chunks) chunks.push(chunk);
          await handle.write(chunk);
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (chunks) kitBuffer = Buffer.concat(chunks);
      if (entryPath !== 'checksums.json') {
        const expected = checksums.get(entryPath);
        if (!expected || expected.size !== size || expected.sha256 !== hash.digest('hex')) {
          throw new Error(`Internal checksum mismatch for ${entryPath}`);
        }
      }
    }
    return {
      manifest: parseKitPackageManifest(JSON.parse(kitBuffer.toString('utf8'))),
      files: entries.length,
    };
  } finally {
    zip.close();
  }
}
