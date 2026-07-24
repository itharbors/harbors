import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildDesktop, stageDesktopFiles } from './desktop-build.mjs';

async function write(root, relative, contents = relative) {
  const filename = path.join(root, relative);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, contents);
}

async function createRepositoryFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-desktop-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const relative of [
    'scripts/electron-preload.cjs',
    'scripts/notification-preload.cjs',
    'scripts/kit-manager-preload.cjs',
    'scripts/kit-manager-renderer.mjs',
    'scripts/kit-manager.css',
    'scripts/kit-manager.html',
    'scripts/assets/tray-icon.png',
    'scripts/assets/tray-icon@2x.png',
  ]) await write(root, relative);
  await write(root, 'scripts/electron.mjs', 'export const main = true;\n');
  await write(root, 'packages/desktop/src/framework.mjs', 'export const framework = true;\n');
  await write(root, 'packages/client/dist/index.html', '<script src="/assets/index.js"></script>');
  await write(root, 'packages/client/dist/assets/index.js', 'export const client = true;\n');
  for (const plugin of ['config', 'menu', 'message', 'panel']) {
    await write(root, `plugins/${plugin}/package.json`, JSON.stringify({ name: `@itharbors/${plugin}` }));
    await write(root, `plugins/${plugin}/main/dist/index.js`, `export const ${plugin} = true;\n`);
    await write(root, `plugins/${plugin}/main/src/index.ts`, 'throw new Error();\n');
  }
  await write(root, 'kits/default/package.json', JSON.stringify({ name: '@itharbors/kit-default' }));
  await write(root, 'kits/default/layout.json', '{}');
  await write(root, 'kits/default/main.html', '<main></main>');
  await write(root, 'kits/default/secondary.html', '<main></main>');
  for (const [plugin, panel] of [
    ['log', 'panel.log'],
    ['message-debug', 'panel.debug'],
    ['plugin-detail', 'panel.detail'],
    ['plugin-list', 'panel.list'],
    ['status-bar', 'panel.status'],
    ['title-bar', 'panel.title'],
  ]) {
    await write(root, `kits/default/plugins/${plugin}/package.json`, JSON.stringify({ name: plugin }));
    await write(root, `kits/default/plugins/${plugin}/main/dist/index.js`, 'export default {};\n');
    await write(root, `kits/default/plugins/${plugin}/main/src/index.ts`, 'throw new Error();\n');
    await write(root, `kits/default/plugins/${plugin}/${panel}/dist/index.html`, '<main></main>');
    await write(root, `kits/default/plugins/${plugin}/${panel}/dist/index.js`, 'export {};\n');
  }
  await write(root, '.agents/skills/notify-user/SKILL.md', 'name: notify-user\n');
  await write(root, '.agents/skills/notify-user/agents/openai.yaml', 'name: Notify User\n');
  await write(root, '.agents/skills/notify-user/scripts/notify.mjs', 'export {};\n');
  await write(root, '.agents/skills/notify-user/tests/forbidden.test.mjs', 'throw new Error();\n');
  return root;
}

async function topLevel(directory) {
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

test('stages a deterministic minimum runtime and excludes product Kits', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  const outputRoot = path.join(repositoryRoot, 'dist', 'desktop-runtime');
  const result = await buildDesktop({ repositoryRoot, outputRoot });

  assert.deepEqual(await topLevel(path.join(outputRoot, 'kits')), ['default']);
  assert.equal(existsSync(path.join(outputRoot, 'client', 'assets', 'index.js')), true);
  assert.equal(existsSync(path.join(outputRoot, 'plugins', 'menu', 'package.json')), true);
  assert.equal(existsSync(path.join(outputRoot, 'resources', 'notify-user', 'SKILL.md')), true);
  assert.equal(existsSync(path.join(outputRoot, 'resources', 'notify-user', 'tests')), false);
  assert.equal(existsSync(path.join(outputRoot, 'plugins', 'menu', 'main', 'src')), false);
  assert.equal(existsSync(path.join(outputRoot, 'kits', 'default', 'plugins', 'log', 'main', 'src')), false);
  for (const forbidden of ['mysql', 'sqlite', 'notifications']) {
    assert.equal(existsSync(path.join(outputRoot, 'kits', forbidden)), false);
  }
  assert.deepEqual(result.inventory, [...result.inventory].sort());
  for (const filename of [
    'main.mjs',
    'framework.mjs',
    'electron-preload.cjs',
    'notification-preload.cjs',
    'kit-manager-preload.cjs',
    'kit-manager-renderer.mjs',
    'kit-manager.css',
    'kit-manager.html',
    'assets/tray-icon.png',
    'assets/tray-icon@2x.png',
  ]) {
    assert.equal(existsSync(path.join(repositoryRoot, 'packages', 'desktop', 'dist', filename)), true);
  }
  for (const filename of ['tray-icon.png', 'tray-icon@2x.png']) {
    assert.deepEqual(
      await readFile(path.join(repositoryRoot, 'packages', 'desktop', 'dist', 'assets', filename)),
      await readFile(path.join(repositoryRoot, 'scripts', 'assets', filename)),
    );
  }
  assert.match(await readFile(path.join(repositoryRoot, 'packages/desktop/dist/main.mjs'), 'utf8'), /main/);
});

test('rejects missing files, symlinks, repository escapes, duplicate destinations, and product Kits', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  const outputRoot = path.join(repositoryRoot, 'dist', 'stage-test');
  const outside = path.join(path.dirname(repositoryRoot), `${path.basename(repositoryRoot)}-outside.txt`);
  await writeFile(outside, 'outside');
  t.after(() => rm(outside, { force: true }));
  await symlink(outside, path.join(repositoryRoot, 'linked.txt'));

  await assert.rejects(stageDesktopFiles({
    repositoryRoot,
    outputRoot,
    entries: [{ source: 'missing.txt', destination: 'missing.txt' }],
  }), /missing|regular file/iu);
  await assert.rejects(stageDesktopFiles({
    repositoryRoot,
    outputRoot,
    entries: [{ source: 'linked.txt', destination: 'linked.txt' }],
  }), /symbolic link/iu);
  await assert.rejects(stageDesktopFiles({
    repositoryRoot,
    outputRoot,
    entries: [{ source: `../${path.basename(outside)}`, destination: 'outside.txt' }],
  }), /outside.*repository/iu);
  await assert.rejects(stageDesktopFiles({
    repositoryRoot,
    outputRoot,
    entries: [
      { source: 'kits/default/package.json', destination: 'same.json' },
      { source: 'kits/default/layout.json', destination: 'same.json' },
    ],
  }), /duplicate destination/iu);
  await assert.rejects(stageDesktopFiles({
    repositoryRoot,
    outputRoot,
    entries: [{ source: 'kits/mysql/package.json', destination: 'kits/mysql/package.json' }],
  }), /product Kit/iu);
});

test('rejects sockets and symlinks found while expanding a directory', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  const outputRoot = path.join(repositoryRoot, 'dist', 'stage-tree-test');
  const source = path.join(repositoryRoot, 'tree');
  await mkdir(source);
  await write(source, 'file.txt', 'file');
  await symlink(path.join(source, 'file.txt'), path.join(source, 'linked.txt'));
  await assert.rejects(stageDesktopFiles({
    repositoryRoot,
    outputRoot,
    entries: [{ source: 'tree', destination: 'tree', recursive: true }],
  }), /symbolic link/iu);
  await rm(path.join(source, 'linked.txt'));

  const socketPath = path.join(source, 'local.sock');
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await assert.rejects(stageDesktopFiles({
    repositoryRoot,
    outputRoot,
    entries: [{ source: 'tree', destination: 'tree', recursive: true }],
  }), /regular file|directory/iu);
});

test('rejects output symlink escapes before copying any file', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'harbors-desktop-output-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const linkedOutput = path.join(repositoryRoot, 'linked-output');
  await symlink(outside, linkedOutput);

  await assert.rejects(stageDesktopFiles({
    repositoryRoot,
    outputRoot: path.join(linkedOutput, 'runtime'),
    entries: [{ source: 'kits/default/package.json', destination: 'package.json' }],
  }), /output.*symbolic link/iu);
  assert.equal(existsSync(path.join(outside, 'runtime', 'package.json')), false);
});

test('validates bundle entries before replacing previous generated output', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  const outputRoot = path.join(repositoryRoot, 'dist', 'desktop-runtime');
  const sentinel = path.join(repositoryRoot, 'packages', 'desktop', 'dist', 'sentinel.txt');
  await mkdir(path.dirname(sentinel), { recursive: true });
  await writeFile(sentinel, 'previous output');
  await rm(path.join(repositoryRoot, 'packages', 'desktop', 'src', 'framework.mjs'));

  await assert.rejects(
    buildDesktop({ repositoryRoot, outputRoot }),
    /missing|regular file|Could not resolve/iu,
  );
  assert.equal(await readFile(sentinel, 'utf8'), 'previous output');
});
