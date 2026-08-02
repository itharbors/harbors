import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = new URL('../plan-kit-releases.mjs', import.meta.url);

async function writeJson(root, relative, value) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeKit(root, slug, version, channel = 'preview') {
  const id = `@itharbors/kit-${slug}`;
  await Promise.all([
    writeJson(root, `kits/${slug}/kit.json`, { id, version, channel }),
    writeJson(root, `kits/${slug}/package.json`, { name: id, version }),
    writeJson(root, `kits/${slug}/package-lock.json`, { packages: { '': { name: id, version } } }),
  ]);
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-release-intent-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  await writeJson(root, 'registry/policy.json', { kits: { sqlite: { id: '@itharbors/kit-sqlite' } } });
  await writeKit(root, 'sqlite', '0.1.0-preview.1');
  await writeFile(path.join(root, 'kits/sqlite/source.txt'), 'base\n');
  git(root, 'add', 'registry', 'kits');
  git(root, 'commit', '-qm', 'base');
  return root;
}

test('CLI emits a deterministic plan from two real Git revisions', async () => {
  const root = await fixture();
  try {
    const base = git(root, 'rev-parse', 'HEAD');
    await writeKit(root, 'sqlite', '0.1.0-preview.2');
    await writeFile(path.join(root, 'kits/sqlite/source.txt'), 'next\n');
    git(root, 'add', 'kits/sqlite');
    git(root, 'commit', '-qm', 'next');
    const head = git(root, 'rev-parse', 'HEAD');

    const run = spawnSync(process.execPath, [script.pathname, base, head], { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
    assert.equal(run.stdout, 'RELEASES_JSON=[{"slug":"sqlite","version":"0.1.0-preview.2","channel":"preview","tag":"kit/sqlite/v0.1.0-preview.2"}]\nHAS_RELEASES=true\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI rejects a changed market Kit whose version did not increase', async () => {
  const root = await fixture();
  try {
    const base = git(root, 'rev-parse', 'HEAD');
    await writeFile(path.join(root, 'kits/sqlite/source.txt'), 'changed\n');
    git(root, 'add', 'kits/sqlite/source.txt');
    git(root, 'commit', '-qm', 'changed');
    const head = git(root, 'rev-parse', 'HEAD');
    const run = spawnSync(process.execPath, [script.pathname, base, head], { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /^ERROR=Kit version for sqlite must increase from 0\.1\.0-preview\.1, got 0\.1\.0-preview\.1\n$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI rejects invalid arguments before invoking Git', () => {
  const run = spawnSync(process.execPath, [script.pathname, 'HEAD', 'main'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, 'Usage: node scripts/plan-kit-releases.mjs <base-sha> <head-sha>\n');
});
