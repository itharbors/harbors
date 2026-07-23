import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const repository = path.resolve(new URL('../..', import.meta.url).pathname);
const migrationScript = path.join(repository, 'scripts/migrate-kit-registry.mjs');

test('generates an isolated Kit Registry branch snapshot', async (context) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'harbors-kit-registry-'));
  const output = path.join(temp, 'registry');
  context.after(() => rm(temp, { recursive: true, force: true }));

  await execFileAsync(process.execPath, [migrationScript, '--output', output], { cwd: repository });

  const workflow = await readFile(path.join(output, '.github/workflows/registry-pages.yml'), 'utf8');
  const revocations = JSON.parse(await readFile(path.join(output, 'registry/revocations.json'), 'utf8'));
  const provenance = JSON.parse(await readFile(path.join(output, '.harbors-registry.json'), 'utf8'));
  const agents = await readFile(path.join(output, 'AGENTS.md'), 'utf8');
  const readme = await readFile(path.join(output, 'README.md'), 'utf8');

  assert.match(workflow, /branches:\s*\n\s*- kit-registry/u);
  assert.match(workflow, /ref:\s*kit-publish-v1/u);
  assert.deepEqual(revocations, { schemaVersion: 1, revocations: [] });
  assert.equal(await readFile(path.join(output, 'registry/entries/.gitkeep'), 'utf8'), '\n');
  assert.equal(provenance.schemaVersion, 1);
  assert.match(provenance.sourceFrameworkCommit, /^[a-f0-9]{40}$/u);
  assert.match(agents, /kit-registry/u);
  assert.match(agents, /\[Init\]/u);
  assert.match(readme, /GitHub Pages/u);
  assert.match(readme, /registry\/entries/u);
});

test('Registry migration refuses to overwrite existing content', async (context) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'harbors-kit-registry-existing-'));
  const output = path.join(temp, 'occupied');
  context.after(() => rm(temp, { recursive: true, force: true }));
  await mkdir(output);
  await writeFile(path.join(output, 'keep.txt'), 'owned\n');

  await assert.rejects(
    execFileAsync(process.execPath, [migrationScript, '--output', output], { cwd: repository }),
    /output directory already exists/u,
  );
  assert.equal(await readFile(path.join(output, 'keep.txt'), 'utf8'), 'owned\n');
});
