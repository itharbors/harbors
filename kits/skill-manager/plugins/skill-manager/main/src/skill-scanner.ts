import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { digestSkillDirectory } from './digest.js';
import { parseSkillFrontmatter } from './frontmatter.js';
import {
  SkillManagerError,
  type ScanOptions,
  type RecoveryEntry,
  type SkillCandidate,
  type SkillDiagnostic,
  type SkillOrigin,
  type SkillScanResult,
} from './types.js';

const IGNORED_SOURCE_DIRECTORIES = new Set([
  '.git',
  '.worktrees',
  'node_modules',
  'skill-manager-store',
]);

export async function scanSourceRoot(
  root: string,
  options: ScanOptions,
): Promise<SkillScanResult> {
  throwIfCancelled(options.signal);
  const candidates: SkillCandidate[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  const state = { truncated: false };

  if (!await validateRoot(root, diagnostics, options.signal)) {
    return { candidates, diagnostics, truncated: state.truncated };
  }
  await visitSourceDirectory(root, root, candidates, diagnostics, state, options);
  markOverlaps(root, candidates);
  return { candidates, diagnostics, truncated: state.truncated };
}

export async function scanGlobalRoot(
  root: string,
  options: ScanOptions,
): Promise<SkillScanResult> {
  throwIfCancelled(options.signal);
  const candidates: SkillCandidate[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  const state = { truncated: false };

  if (!await validateRoot(root, diagnostics, options.signal)) {
    return { candidates, diagnostics, truncated: state.truncated };
  }

  const rootEntries = await readDirectory(root, root, diagnostics, options.signal);
  for (const entry of rootEntries) {
    if (entry.name === '.system') continue;
    const directory = path.join(root, entry.name);
    if (entry.isDirectory()) {
      candidates.push(await scanCandidate(root, directory, 'global', false, state, options));
    } else if (entry.isSymbolicLink()) {
      candidates.push(invalidCandidate(root, directory, 'global', false, {
        code: 'UNSAFE_PATH',
        message: 'Global Skill entry must not be a symbolic link',
        relativePath: entry.name,
      }));
    }
  }

  const systemRoot = path.join(root, '.system');
  const systemStat = await lstat(systemRoot).catch(() => null);
  if (systemStat?.isDirectory() && !systemStat.isSymbolicLink()) {
    const systemEntries = await readDirectory(root, systemRoot, diagnostics, options.signal);
    for (const entry of systemEntries) {
      const directory = path.join(systemRoot, entry.name);
      if (entry.isDirectory()) {
        candidates.push(await scanCandidate(root, directory, 'system', true, state, options));
      } else if (entry.isSymbolicLink()) {
        candidates.push(invalidCandidate(root, directory, 'system', true, {
          code: 'UNSAFE_PATH',
          message: 'System Skill entry must not be a symbolic link',
          relativePath: toPortablePath(path.relative(root, directory)),
        }));
      }
    }
  } else if (systemStat !== null) {
    diagnostics.push({
      code: 'UNSAFE_PATH',
      message: '.system must be a regular directory',
      relativePath: '.system',
    });
  }

  candidates.sort((left, right) => compareText(
    toPortablePath(path.relative(root, left.directory)),
    toPortablePath(path.relative(root, right.directory)),
  ));
  return { candidates, diagnostics, truncated: state.truncated };
}

export function recoveryEntriesToCandidates(entries: RecoveryEntry[]): SkillCandidate[] {
  return entries
    .map((entry) => ({
      id: entry.id,
      origin: entry.action,
      directory: entry.directory,
      basename: entry.originalBasename,
      manifest: entry.valid && entry.manifest ? { ...entry.manifest } : null,
      digest: entry.valid ? entry.digest : null,
      protected: false,
      diagnostics: entry.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    }))
    .sort((left, right) => compareText(left.id, right.id));
}

async function visitSourceDirectory(
  root: string,
  directory: string,
  candidates: SkillCandidate[],
  diagnostics: SkillDiagnostic[],
  state: { truncated: boolean },
  options: ScanOptions,
): Promise<void> {
  throwIfCancelled(options.signal);
  const entries = await readDirectory(root, directory, diagnostics, options.signal);
  const skillEntry = entries.find((entry) => entry.name === 'SKILL.md');
  if (skillEntry) {
    if (skillEntry.isFile()) {
      candidates.push(await scanCandidate(root, directory, 'source', false, state, options));
    } else {
      candidates.push(invalidCandidate(root, directory, 'source', false, {
        code: 'UNSAFE_PATH',
        message: 'SKILL.md must be a regular file',
        relativePath: toPortablePath(path.relative(root, path.join(directory, 'SKILL.md'))),
      }));
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || IGNORED_SOURCE_DIRECTORIES.has(entry.name)) continue;
    await visitSourceDirectory(
      root,
      path.join(directory, entry.name),
      candidates,
      diagnostics,
      state,
      options,
    );
  }
}

async function scanCandidate(
  scanRoot: string,
  directory: string,
  origin: SkillOrigin,
  protectedSkill: boolean,
  state: { truncated: boolean },
  options: ScanOptions,
): Promise<SkillCandidate> {
  const diagnostics: SkillDiagnostic[] = [];
  const skillPath = path.join(directory, 'SKILL.md');
  const relativeSkillPath = toPortablePath(path.relative(scanRoot, skillPath));
  let manifest = null;
  let digest = null;

  try {
    throwIfCancelled(options.signal);
    const skillStat = await lstat(skillPath);
    if (!skillStat.isFile() || skillStat.isSymbolicLink()) {
      throw new SkillManagerError('UNSAFE_PATH', 'SKILL.md must be a regular file');
    }
    manifest = parseSkillFrontmatter(await readFile(skillPath, 'utf8'));
    digest = (await digestSkillDirectory(directory, options.limits, options.signal)).value;
  } catch (caught) {
    if (isCancellation(caught)) throw caught;
    const diagnostic = diagnosticFromError(caught, relativeSkillPath);
    diagnostics.push(diagnostic);
    if (diagnostic.code === 'SCAN_LIMIT') state.truncated = true;
  }

  return {
    id: candidateId(origin, directory),
    origin,
    directory,
    basename: path.basename(directory),
    manifest,
    digest,
    protected: protectedSkill,
    diagnostics,
  };
}

function invalidCandidate(
  scanRoot: string,
  directory: string,
  origin: SkillOrigin,
  protectedSkill: boolean,
  diagnostic: SkillDiagnostic,
): SkillCandidate {
  return {
    id: candidateId(origin, directory),
    origin,
    directory,
    basename: path.basename(directory),
    manifest: null,
    digest: null,
    protected: protectedSkill,
    diagnostics: [{
      ...diagnostic,
      relativePath: diagnostic.relativePath
        ?? toPortablePath(path.relative(scanRoot, directory)),
    }],
  };
}

async function validateRoot(
  root: string,
  diagnostics: SkillDiagnostic[],
  signal?: AbortSignal,
): Promise<boolean> {
  throwIfCancelled(signal);
  try {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      diagnostics.push({ code: 'UNSAFE_PATH', message: 'Scan root must be a regular directory' });
      return false;
    }
    return true;
  } catch (caught) {
    diagnostics.push(diagnosticFromError(caught));
    return false;
  }
}

async function readDirectory(
  root: string,
  directory: string,
  diagnostics: SkillDiagnostic[],
  signal?: AbortSignal,
) {
  throwIfCancelled(signal);
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.sort((left, right) => compareText(left.name, right.name));
  } catch (caught) {
    diagnostics.push(diagnosticFromError(
      caught,
      toPortablePath(path.relative(root, directory)) || '.',
    ));
    return [];
  }
}

function markOverlaps(root: string, candidates: SkillCandidate[]): void {
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const left = candidates[leftIndex];
      const right = candidates[rightIndex];
      if (!isAncestor(left.directory, right.directory) && !isAncestor(right.directory, left.directory)) {
        continue;
      }
      const diagnostic = (other: SkillCandidate): SkillDiagnostic => ({
        code: 'OVERLAPPING_SKILL',
        message: `Skill directory overlaps ${other.basename}`,
        relativePath: toPortablePath(path.relative(root, other.directory)),
      });
      left.diagnostics.push(diagnostic(right));
      right.diagnostics.push(diagnostic(left));
    }
  }
}

function isAncestor(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function diagnosticFromError(caught: unknown, relativePath?: string): SkillDiagnostic {
  if (caught instanceof SkillManagerError) {
    return { code: caught.code, message: caught.message, relativePath };
  }
  const error = caught as NodeJS.ErrnoException;
  if (error?.code === 'ENOENT') {
    return {
      code: 'INVALID_SKILL',
      message: 'Required Skill file or directory is missing',
      relativePath,
    };
  }
  if (error?.code === 'EACCES' || error?.code === 'EPERM') {
    return {
      code: 'INVALID_SKILL',
      message: 'Skill file or directory cannot be read',
      relativePath,
    };
  }
  return {
    code: 'INVALID_SKILL',
    message: 'Skill file or directory could not be scanned',
    relativePath,
  };
}

function candidateId(origin: SkillOrigin, directory: string): string {
  return createHash('sha256').update(`${origin}\0${directory}`).digest('hex').slice(0, 24);
}

function isCancellation(caught: unknown): boolean {
  return caught instanceof SkillManagerError && caught.code === 'SCAN_CANCELLED';
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new SkillManagerError('SCAN_CANCELLED', 'Skill scan was cancelled');
  }
}

function toPortablePath(value: string): string {
  return value.split(path.sep).join('/');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
