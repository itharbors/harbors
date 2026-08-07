import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DESKTOP_RUNTIME_MANIFEST = 'runtime-manifest.json';

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function inventory(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = path.posix.join(prefix, entry.name);
    if (relative === DESKTOP_RUNTIME_MANIFEST) continue;
    const absolute = path.join(directory, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`Desktop runtime contains symbolic link ${relative}`);
    if (info.isDirectory()) files.push(...await inventory(absolute, relative));
    else if (info.isFile()) files.push({ path: relative, sha256: await sha256(absolute), size: info.size });
    else throw new Error(`Desktop runtime contains non-regular entry ${relative}`);
  }
  return files;
}

function parseManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 1 || !Array.isArray(value.files)
    || Object.keys(value).some((key) => !['schemaVersion', 'files'].includes(key))) {
    throw new Error('Desktop runtime manifest is malformed');
  }
  const paths = new Set();
  const files = value.files.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).some((key) => !['path', 'sha256', 'size'].includes(key))
      || typeof entry.path !== 'string' || !/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+/u.test(entry.path)
      || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256)
      || !Number.isSafeInteger(entry.size) || entry.size < 0 || paths.has(entry.path)) {
      throw new Error('Desktop runtime manifest contains an invalid file record');
    }
    paths.add(entry.path);
    return { path: entry.path, sha256: entry.sha256, size: entry.size };
  });
  return { schemaVersion: 1, files };
}

export async function createDesktopRuntimeManifest(runtimeRoot) {
  const manifest = { schemaVersion: 1, files: await inventory(runtimeRoot) };
  await writeFile(
    path.join(runtimeRoot, DESKTOP_RUNTIME_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  return Object.freeze(manifest);
}

export async function verifyDesktopRuntimeManifest(runtimeRoot) {
  let manifest;
  try {
    manifest = parseManifest(JSON.parse(await readFile(path.join(runtimeRoot, DESKTOP_RUNTIME_MANIFEST), 'utf8')));
  } catch (error) {
    throw new Error('Packaged desktop runtime verification failed: invalid runtime manifest', { cause: error });
  }
  const actual = await inventory(runtimeRoot).catch((error) => {
    throw new Error(`Packaged desktop runtime verification failed: ${error.message}`, { cause: error });
  });
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) {
    throw new Error('Packaged desktop runtime verification failed: file closure or checksum mismatch');
  }
  return Object.freeze({ files: actual.length });
}
