import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const forbiddenPrefixes = [
  ['@', 'ce/'].join(''),
  ['%40', 'ce%2F'].join(''),
  ['%40', 'ce%2f'].join(''),
];
const excludedDirectories = new Set([
  '.git',
  '.worktrees',
  'coverage',
  'dist',
  'node_modules',
]);
const textExtensions = new Set([
  '.cjs',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.ts',
]);

test('all plugin package references use the itharbors namespace', async () => {
  const violations = [];
  await visit(projectRoot, violations);

  assert.deepEqual(
    violations,
    [],
    `legacy plugin namespace remains in:\n${violations.join('\n')}`,
  );
});

async function visit(directory, violations) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(absolutePath, violations);
      continue;
    }
    if (!entry.isFile() || !textExtensions.has(path.extname(entry.name))) continue;
    const content = await readFile(absolutePath, 'utf8');
    if (forbiddenPrefixes.some((prefix) => content.includes(prefix))) {
      violations.push(path.relative(projectRoot, absolutePath));
    }
  }
}
