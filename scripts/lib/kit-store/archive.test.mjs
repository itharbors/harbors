import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import test from 'node:test';
import { ZipFile } from 'yazl';

import { packKit } from '../../../packages/kit-cli/dist/index.js';
import { extractVerifiedArchive } from './archive.mjs';

const fixture = path.resolve('packages/kit-cli/tests/fixtures/minimal-kit');

test('extracts a verified archive as private regular files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-kit-extract-'));
  const packed = await packKit({ directory: fixture, output: path.join(root, 'demo.hkit') });
  const destination = path.join(root, 'staging');
  const result = await extractVerifiedArchive({ archivePath: packed.output, destination });
  assert.equal(result.manifest.id, '@example/kit-demo');
  assert.equal((await readdir(destination)).includes('checksums.json'), true);
  assert.equal((await stat(path.join(destination, 'kit.json'))).mode & 0o777, 0o600);
});

test('rejects an internally mismatched checksum', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-kit-extract-'));
  const archive = path.join(root, 'demo.hkit');
  const kit = await readFile(path.join(fixture, 'kit.json'));
  const sbom = Buffer.from('{}\n');
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  const checksums = Buffer.from(`${JSON.stringify({ schemaVersion: 1, files: [
    { path: 'kit.json', sha256: hash(kit), size: kit.length },
    { path: 'payload.txt', sha256: '0'.repeat(64), size: 7 },
    { path: 'sbom.spdx.json', sha256: hash(sbom), size: sbom.length },
  ] })}\n`);
  const zip = new ZipFile();
  const output = createWriteStream(archive);
  zip.outputStream.pipe(output);
  for (const [name, data] of [
    ['checksums.json', checksums], ['kit.json', kit],
    ['payload.txt', Buffer.from('payload')], ['sbom.spdx.json', sbom],
  ]) zip.addBuffer(data, name, { mode: 0o100644 });
  zip.end();
  await finished(output);
  await assert.rejects(
    extractVerifiedArchive({ archivePath: archive, destination: path.join(root, 'staging') }),
    /checksum mismatch.*payload\.txt/i,
  );
});
