import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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
  const { stdout } = await execFileAsync('git', ['ls-files', '-z'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });

  for (const relativePath of stdout.split('\0').filter(Boolean)) {
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

function hasLegacyNamespace(content) {
  return forbiddenNamespacePatterns.some((pattern) => pattern.test(content));
}
