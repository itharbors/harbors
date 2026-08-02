import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const execFileAsync = promisify(execFile);
const forbiddenNamespacePatterns = [
  /@c[e](?:%2f|(?![a-z0-9._!~*'()%-]))/i,
  /%40c[e](?:%2f|(?![a-z0-9._!~*'()%-]))/i,
];

test('legacy namespace detection respects package-name boundaries', () => {
  const legacyScope = ['@', 'ce'].join('');
  const encodedLegacyScope = ['%40', 'ce'].join('');

  assert.equal(hasLegacyNamespace(`${legacyScope}/plugin`), true);
  assert.equal(hasLegacyNamespace(`${legacyScope}\\/plugin`), true);
  assert.equal(hasLegacyNamespace(`${legacyScope}%2Fplugin`), true);
  assert.equal(hasLegacyNamespace(encodedLegacyScope), true);
  assert.equal(hasLegacyNamespace(`${encodedLegacyScope}%2Fplugin`), true);
  assert.equal(hasLegacyNamespace(`${legacyScope}nter/plugin`), false);
  assert.equal(hasLegacyNamespace(`${legacyScope}-tools/plugin`), false);
  assert.equal(hasLegacyNamespace(`${legacyScope}.tools/plugin`), false);
  assert.equal(hasLegacyNamespace(`${legacyScope}~tools/plugin`), false);
  assert.equal(hasLegacyNamespace(`${legacyScope}!tools/plugin`), false);
  assert.equal(hasLegacyNamespace(`${legacyScope}'tools/plugin`), false);
  assert.equal(hasLegacyNamespace(`${legacyScope}%7Etools/plugin`), false);
  assert.equal(hasLegacyNamespace(`${encodedLegacyScope}%7Etools%2Fplugin`), false);
});

test('all tracked repository references use the itharbors namespace', async () => {
  const violations = [];

  for (const relativePath of await listTrackedWorktreeFiles(projectRoot)) {
    const content = await readFile(path.join(projectRoot, relativePath), 'utf8');
    if (!content.includes('\0') && hasLegacyNamespace(content)) {
      violations.push(relativePath);
    }
  }

  assert.deepEqual(
    violations,
    [],
    `legacy plugin namespace remains in:\n${violations.join('\n')}`,
  );
});

test('tracked worktree enumeration excludes unstaged deletions without splitting filenames', async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'plugin-namespace-'));
  const retainedPath = 'retained\nreference.txt';
  const deletedPath = 'deleted-reference.txt';

  try {
    await execFileAsync('git', ['init', '--quiet'], { cwd: repository });
    await writeFile(path.join(repository, retainedPath), 'retained', 'utf8');
    await writeFile(path.join(repository, deletedPath), 'deleted', 'utf8');
    await execFileAsync('git', ['add', '--', retainedPath, deletedPath], { cwd: repository });
    await unlink(path.join(repository, deletedPath));

    assert.deepEqual(await listTrackedWorktreeFiles(repository), [retainedPath]);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

async function listTrackedWorktreeFiles(repositoryRoot) {
  const options = { cwd: repositoryRoot, encoding: 'utf8' };
  const [{ stdout: trackedOutput }, { stdout: deletedOutput }] = await Promise.all([
    execFileAsync('git', ['ls-files', '-z'], options),
    execFileAsync('git', ['ls-files', '--deleted', '-z'], options),
  ]);
  const deletedPaths = new Set(deletedOutput.split('\0').filter(Boolean));
  return trackedOutput
    .split('\0')
    .filter((relativePath) => relativePath && !deletedPaths.has(relativePath));
}

function hasLegacyNamespace(content) {
  return forbiddenNamespacePatterns.some((pattern) => pattern.test(content));
}
