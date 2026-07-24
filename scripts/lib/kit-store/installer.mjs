import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { checkKitCompatibility, encodeKitId } from '@itharbors/kit-core';

import { extractVerifiedArchive } from './archive.mjs';

let sequence = 0;

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export class KitArtifactInstaller {
  constructor({ storeRoot, store, runtime, extractArchive = extractVerifiedArchive }) {
    this.storeRoot = path.resolve(storeRoot);
    this.store = store;
    this.runtime = runtime;
    this.extractArchive = extractArchive;
  }

  async installFromFile({ archivePath, expected }) {
    const archive = path.resolve(archivePath);
    const downloads = path.join(this.storeRoot, 'downloads');
    const stagingRoot = path.join(this.storeRoot, 'staging');
    await mkdir(downloads, { recursive: true });
    await mkdir(stagingRoot, { recursive: true });
    let staging;
    try {
      const info = await stat(archive);
      if (!info.isFile() || info.size !== expected.size) throw new Error('Kit artifact size does not match release metadata');
      const digest = await sha256(archive);
      if (digest !== expected.sha256) throw new Error('Kit artifact SHA-256 does not match release metadata');

      const encoded = encodeKitId(expected.id);
      const destination = path.join(this.storeRoot, 'kits', encoded, expected.version);
      const snapshot = await this.store.snapshot();
      const existing = snapshot.kits[expected.id]?.versions?.[expected.version];
      if (existing) {
        if (existing.digest !== digest) throw new Error('Installed Kit version is immutable and has a different digest');
        return { status: 'already-installed', directory: existing.directory, digest };
      }

      staging = path.join(stagingRoot, `${encoded}-${expected.version}-${process.pid}-${sequence += 1}`);
      await mkdir(staging, { recursive: false, mode: 0o700 });
      const extracted = await this.extractArchive({ archivePath: archive, destination: staging });
      const manifest = extracted.manifest;
      if (manifest.id !== expected.id || manifest.version !== expected.version || manifest.publisher !== expected.publisher) {
        throw new Error('Kit artifact identity does not match release metadata');
      }
      const compatibility = checkKitCompatibility(manifest, this.runtime);
      if (!compatibility.compatible) throw new Error(`${compatibility.reason}: ${compatibility.message}`);
      const runtimeManifest = JSON.parse(await readFile(path.join(staging, 'package.json'), 'utf8'));
      if (runtimeManifest.name !== manifest.id || runtimeManifest.version !== manifest.version || !runtimeManifest['ce-editor']?.kit) {
        throw new Error('Extracted runtime package.json does not match Kit identity');
      }
      await mkdir(path.dirname(destination), { recursive: true });
      await rename(staging, destination);
      try {
        await this.store.recordInstalled({
          id: manifest.id,
          version: manifest.version,
          directory: destination,
          digest,
          source: {
            publisher: expected.publisher,
            repository: expected.repository,
            commit: expected.commit,
          },
          channel: manifest.channel,
        });
      } catch (error) {
        try {
          await rm(destination, { recursive: true, force: true });
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'Kit state persistence and destination rollback both failed',
          );
        }
        throw error;
      }
      return { status: 'installed', directory: destination, digest };
    } finally {
      if (staging) await rm(staging, { recursive: true, force: true });
      if (inside(downloads, archive)) await rm(archive, { force: true });
    }
  }
}
