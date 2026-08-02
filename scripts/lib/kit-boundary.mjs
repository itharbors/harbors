import { spawn } from 'node:child_process';

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/u;
const SIMPLE_STATUS_PATTERN = /^[AMDT]$/u;
const SCORED_STATUS_PATTERN = /^([RC])([0-9]{3})$/u;
// C0 controls (U+0000-U+001F), DEL (U+007F), C1 controls (U+0080-U+009F),
// and Unicode line/paragraph separators (U+2028, U+2029).
// Built from ASCII escape sequences only - no literal control bytes in source.
const CONTROL_CHARACTER = new RegExp(
  '['
  + '\\u0000-\\u001f'
  + '\\u007f-\\u009f'
  + '\\u2028\\u2029'
  + ']',
  'u',
);
const CONTROL_CHARACTERS = new RegExp(
  CONTROL_CHARACTER.source,
  'gu',
);
const ALLOWED_FILE_MODES = new Set(['100644', '100755']);
const MODE_PATTERN = /^[0-7]{6}$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function decodeUtf8(buffer) {
  try {
    return utf8Decoder.decode(buffer);
  } catch {
    throw new Error('git output is not valid UTF-8');
  }
}

export function sanitizeBoundaryError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(/\s+/gu, ' ')
    .trim() || 'Unknown error';
}

export function isValidKitSlug(slug) {
  return typeof slug === 'string' && SLUG_PATTERN.test(slug);
}

function isValidStatus(status) {
  if (typeof status !== 'string') return false;
  if (SIMPLE_STATUS_PATTERN.test(status)) return true;
  const match = SCORED_STATUS_PATTERN.exec(status);
  return match !== null && Number.parseInt(match[2], 10) <= 100;
}

function isSafeRepositoryPath(path) {
  if (typeof path !== 'string' || path.length === 0) return false;
  if (CONTROL_CHARACTER.test(path)) return false;
  if (path.includes('\\')) return false;
  if (path.startsWith('/')) return false;
  if (/^[a-zA-Z]:[\\/]/u.test(path)) return false;
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return false;
  }
  return true;
}

function isWithinKitBoundary(slug, path) {
  const segments = path.split('/');
  return segments.length >= 3 && segments[0] === 'kits' && segments[1] === slug;
}

export function validateKitChangePaths({ slug, records }) {
  if (!isValidKitSlug(slug)) {
    throw new Error(`invalid Kit slug: ${String(slug)}`);
  }
  if (!Array.isArray(records)) {
    throw new Error('change records must be an array');
  }
  const paths = [];
  for (const record of records) {
    if (!record || typeof record !== 'object') {
      throw new Error('change record is not an object');
    }
    const { status, paths: recordPaths } = record;
    if (!isValidStatus(status)) {
      throw new Error(`invalid change status: ${String(status)}`);
    }
    if (!Array.isArray(recordPaths) || recordPaths.length === 0) {
      throw new Error('change record must list at least one path');
    }
    const isRenameOrCopy = status.startsWith('R') || status.startsWith('C');
    const expectedPathCount = isRenameOrCopy ? 2 : 1;
    if (recordPaths.length !== expectedPathCount) {
      throw new Error(`change record for status ${status} must have ${expectedPathCount} path(s)`);
    }
    for (const candidate of recordPaths) {
      if (!isSafeRepositoryPath(candidate)) {
        throw new Error(`unsafe path in Kit change: ${String(candidate)}`);
      }
      if (!isWithinKitBoundary(slug, candidate)) {
        throw new Error(`change outside kits/${slug}: ${candidate}`);
      }
      paths.push(candidate);
    }
  }
  return Object.freeze({ paths: Object.freeze(paths) });
}

export function parseDiffNameStatus(buffer) {
  const text = decodeUtf8(buffer);
  if (text.length > 0 && !text.endsWith('\0')) {
    throw new Error('diff output is not NUL terminated');
  }
  const tokens = text.split('\0');
  if (tokens.length > 0 && tokens[tokens.length - 1] === '') {
    tokens.pop();
  }
  const records = [];
  let index = 0;
  while (index < tokens.length) {
    const status = tokens[index++];
    if (status === '') {
      throw new Error('empty change status in diff output');
    }
    if (!isValidStatus(status)) {
      throw new Error(`invalid change status: ${status}`);
    }
    const isRenameOrCopy = status.startsWith('R') || status.startsWith('C');
    const pathCount = isRenameOrCopy ? 2 : 1;
    const recordPaths = [];
    for (let offset = 0; offset < pathCount; offset += 1) {
      if (index >= tokens.length) {
        throw new Error(`unexpected end of diff output for status ${status}`);
      }
      recordPaths.push(tokens[index++]);
    }
    records.push(Object.freeze({ status, paths: recordPaths }));
  }
  return records;
}

export function parseLsFilesStageOutput(buffer) {
  const text = decodeUtf8(buffer);
  if (text.length > 0 && !text.endsWith('\0')) {
    throw new Error('ls-files output is not NUL terminated');
  }
  const entries = text.split('\0');
  if (entries.length > 0 && entries[entries.length - 1] === '') {
    entries.pop();
  }
  const modes = new Map();
  for (const entry of entries) {
    if (entry === '') {
      throw new Error('malformed ls-files output: empty entry');
    }
    const tabIndex = entry.indexOf('\t');
    if (tabIndex === -1) {
      throw new Error('malformed ls-files entry: missing path separator');
    }
    const header = entry.slice(0, tabIndex);
    const path = entry.slice(tabIndex + 1);
    const parts = header.split(' ');
    if (parts.length !== 3) {
      throw new Error(`malformed ls-files header for ${path}`);
    }
    const [mode, sha, stage] = parts;
    if (!MODE_PATTERN.test(mode)) {
      throw new Error(`malformed file mode for ${path}: ${mode}`);
    }
    if (!SHA_PATTERN.test(sha)) {
      throw new Error(`malformed object name for ${path}: ${sha}`);
    }
    if (stage !== '0') {
      throw new Error(`unmerged index entry for ${path}: stage ${stage}`);
    }
    if (!isSafeRepositoryPath(path)) {
      throw new Error(`unsafe path in index: ${path}`);
    }
    if (modes.has(path)) {
      throw new Error(`duplicate index entry for ${path}`);
    }
    if (!ALLOWED_FILE_MODES.has(mode)) {
      throw new Error(`disallowed file mode for ${path}: ${mode}`);
    }
    modes.set(path, mode);
  }
  return modes;
}

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, shell: false });
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) {
        reject(new Error(`git terminated by signal ${signal}`));
      } else if (code !== 0) {
        reject(new Error(`git exited with code ${code}: ${stderr.trim()}`));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
  });
}

async function resolveRevision({ repositoryRoot, revision }) {
  if (
    typeof revision !== 'string'
    || revision.length === 0
    || revision.length > 1024
    || revision.startsWith('-')
    || CONTROL_CHARACTER.test(revision)
    || /\s/u.test(revision)
  ) {
    throw new Error('invalid Git revision');
  }
  const output = await runGit(
    ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`],
    repositoryRoot,
  );
  const commitId = decodeUtf8(output).trim();
  if (!/^[0-9a-f]{40}$/u.test(commitId)) {
    throw new Error(`resolved revision is not a commit id: ${commitId}`);
  }
  return commitId;
}

async function assertHeadAndIndexMatch({ repositoryRoot, head }) {
  const requestedHead = await resolveRevision({ repositoryRoot, revision: head });
  const checkedOutHead = await resolveRevision({ repositoryRoot, revision: 'HEAD' });
  if (requestedHead !== checkedOutHead) {
    throw new Error('head revision must resolve to the checked-out HEAD');
  }
  try {
    await runGit(['diff', '--cached', '--quiet', requestedHead, '--'], repositoryRoot);
  } catch {
    throw new Error('index must match the checked-out HEAD');
  }
}

export async function readChangedPathRecords({ repositoryRoot, base, head }) {
  const baseCommit = await resolveRevision({ repositoryRoot, revision: base });
  const headCommit = await resolveRevision({ repositoryRoot, revision: head });
  const output = await runGit(
    ['diff', '--name-status', '-z', '--find-renames', baseCommit, headCommit, '--'],
    repositoryRoot,
  );
  return parseDiffNameStatus(output);
}

export async function readIndexModes({ repositoryRoot, paths }) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return new Map();
  }
  const output = await runGit(
    ['ls-files', '-s', '-z', '--', ...paths],
    repositoryRoot,
  );
  return parseLsFilesStageOutput(output);
}

export async function validateKitChange({ repositoryRoot, slug, base, head }) {
  if (!isValidKitSlug(slug)) {
    throw new Error(`invalid Kit slug: ${String(slug)}`);
  }
  await assertHeadAndIndexMatch({ repositoryRoot, head });
  const records = await readChangedPathRecords({ repositoryRoot, base, head });
  const { paths } = validateKitChangePaths({ slug, records });
  const modes = await readIndexModes({ repositoryRoot, paths });
  for (const record of records) {
    const requiredPaths = record.status === 'D'
      ? []
      : record.status.startsWith('R')
        ? [record.paths[1]]
        : record.paths;
    for (const requiredPath of requiredPaths) {
      if (!modes.has(requiredPath)) {
        throw new Error(`changed path is missing from the HEAD index: ${requiredPath}`);
      }
    }
  }
  return Object.freeze({ paths: Object.freeze([...paths]) });
}
