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

async function updateJson(root, relative, update) {
  const filename = path.join(root, relative);
  const value = JSON.parse(await readFile(filename, 'utf8'));
  update(value);
  await writeFile(filename, JSON.stringify(value));
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
  await write(root, 'scripts/electron.mjs', `
import 'sigstore';
import 'snappyjs';
import 'yauzl';
export const main = true;
`);
  await write(root, 'packages/desktop/src/framework.mjs', 'export const framework = true;\n');
  await write(root, 'packages/client/dist/index.html', '<script src="/assets/index.js"></script>');
  await write(root, 'packages/client/dist/assets/index.js', 'export const client = true;\n');
  for (const plugin of ['config', 'menu', 'message', 'panel']) {
    await write(root, `plugins/${plugin}/package.json`, JSON.stringify({ name: `@itharbors/${plugin}` }));
    await write(root, `plugins/${plugin}/main/dist/index.js`, `export const ${plugin} = true;\n`);
    await write(root, `plugins/${plugin}/main/src/index.ts`, 'throw new Error();\n');
  }
  await write(root, 'kits/default/package.json', JSON.stringify({
    name: '@itharbors/kit-default',
    'ce-editor': {
      kit: {
        layouts: { default: 'layout.json' },
        windowEntries: { main: 'main.html', secondary: 'secondary.html' },
        plugin: [
          'log',
          'message-debug',
          'plugin-detail',
          'plugin-list',
          'status-bar',
          'title-bar',
          '@itharbors/fixture-plugin',
        ],
      },
    },
  }));
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
    await write(root, `kits/default/plugins/${plugin}/package.json`, JSON.stringify({
      name: plugin,
      main: './main/dist/index.js',
      'ce-editor': {
        contribute: {
          panel: {
            [plugin]: { entry: `./${panel}/dist/index.html` },
          },
        },
      },
    }));
    await write(root, `kits/default/plugins/${plugin}/main/dist/index.js`, 'export default {};\n');
    await write(root, `kits/default/plugins/${plugin}/main/src/index.ts`, 'throw new Error();\n');
    await write(root, `kits/default/plugins/${plugin}/${panel}/dist/index.html`, '<main></main>');
    await write(root, `kits/default/plugins/${plugin}/${panel}/dist/index.js`, 'export {};\n');
  }
  await write(root, 'kits/default/plugins/fixture-plugin/package.json', JSON.stringify({
    name: '@itharbors/fixture-plugin',
    main: './main/dist/index.js',
    'ce-editor': {
      contribute: {
        panel: {
          fixture: { entry: './panel.fixture/dist/index.html' },
        },
      },
    },
  }));
  await write(root, 'kits/default/plugins/fixture-plugin/main/dist/index.js', 'export default {};\n');
  await write(root, 'kits/default/plugins/fixture-plugin/main/src/index.ts', 'throw new Error();\n');
  await write(root, 'kits/default/plugins/fixture-plugin/panel.fixture/dist/index.html', '<main></main>');
  await write(root, 'kits/default/plugins/fixture-plugin/panel.fixture/dist/index.js', 'export {};\n');
  await write(root, 'kits/default/plugins/fixture-plugin/panel.fixture/src/index.html', '<main>source</main>');
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
  assert.equal(existsSync(path.join(outputRoot, 'kits', 'default', 'plugins', 'fixture-plugin', 'package.json')), true);
  assert.equal(existsSync(path.join(outputRoot, 'kits', 'default', 'plugins', 'fixture-plugin', 'main', 'dist', 'index.js')), true);
  assert.equal(existsSync(path.join(outputRoot, 'kits', 'default', 'plugins', 'fixture-plugin', 'panel.fixture', 'dist', 'index.html')), true);
  assert.equal(existsSync(path.join(outputRoot, 'kits', 'default', 'plugins', 'fixture-plugin', 'main', 'src')), false);
  for (const forbidden of ['agent-guard', 'csv', 'mysql', 'notifications', 'scheduler', 'skill-manager', 'sqlite']) {
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
  const mainBundle = await readFile(path.join(repositoryRoot, 'packages/desktop/dist/main.mjs'), 'utf8');
  assert.match(mainBundle, /main/);
  for (const name of ['sigstore', 'snappyjs', 'yauzl']) {
    assert.match(mainBundle, new RegExp(`import ['"]${name}['"]`, 'u'));
  }
  assert.doesNotMatch(mainBundle, /node_modules\/@sigstore\//u);
});

test('keeps the native keyring behind an external Framework import', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  const outputRoot = path.join(repositoryRoot, 'dist', 'desktop-runtime');
  await write(repositoryRoot, 'packages/desktop/src/framework.mjs', `
export async function loadKeyring() {
  return import('@itharbors/native-credential-vault');
}
`);
  await write(repositoryRoot, 'node_modules/@itharbors/native-credential-vault/package.json', JSON.stringify({
    name: '@itharbors/native-credential-vault',
    version: '0.0.1',
    main: 'index.cjs',
  }));
  await write(repositoryRoot, 'node_modules/@itharbors/native-credential-vault/index.cjs', `
import { execFile } from 'node:child_process';
export const plaintextStore = new Map();
export const getPassword = execFile;
`);

  await buildDesktop({ repositoryRoot, outputRoot });

  const frameworkBundle = await readFile(
    path.join(repositoryRoot, 'packages', 'desktop', 'dist', 'framework.mjs'),
    'utf8',
  );
  assert.match(frameworkBundle, /import\(["']@itharbors\/native-credential-vault["']\)/u);
  assert.doesNotMatch(frameworkBundle, /child_process|plaintextStore/u);
});

for (const [description, update] of [
  ['a main entrypoint below src', (manifest) => { manifest.main = './main/src/index.js'; }],
  ['a directory-valued main entrypoint', (manifest) => { manifest.main = './main/dist'; }],
  ['a panel entrypoint below src', (manifest) => {
    manifest['ce-editor'].contribute.panel.fixture.entry = './panel.fixture/src/index.html';
  }],
  ['a directory-valued panel entrypoint', (manifest) => {
    manifest['ce-editor'].contribute.panel.fixture.entry = './panel.fixture/dist';
  }],
]) {
  test(`rejects ${description} from a builtin plugin manifest`, async (t) => {
    const repositoryRoot = await createRepositoryFixture(t);
    await updateJson(repositoryRoot, 'kits/default/plugins/fixture-plugin/package.json', update);

    await assert.rejects(
      buildDesktop({
        repositoryRoot,
        outputRoot: path.join(repositoryRoot, 'dist', 'desktop-runtime'),
      }),
      /Desktop plugin (?:main|panel) entrypoint must name a built artifact beneath dist/u,
    );
  });
}

for (const [description, prepare, update] of [
  [
    'a TypeScript main artifact',
    (root) => write(root, 'kits/default/plugins/fixture-plugin/main/dist/index.ts', 'export default {};\n'),
    (manifest) => { manifest.main = './main/dist/index.ts'; },
  ],
  [
    'a panel artifact not named index.html',
    (root) => write(root, 'kits/default/plugins/fixture-plugin/panel.fixture/dist/other.html', '<main></main>'),
    (manifest) => {
      manifest['ce-editor'].contribute.panel.fixture.entry = './panel.fixture/dist/other.html';
    },
  ],
]) {
  test(`rejects ${description} from a builtin plugin manifest`, async (t) => {
    const repositoryRoot = await createRepositoryFixture(t);
    await prepare(repositoryRoot);
    await updateJson(repositoryRoot, 'kits/default/plugins/fixture-plugin/package.json', update);

    await assert.rejects(
      buildDesktop({
        repositoryRoot,
        outputRoot: path.join(repositoryRoot, 'dist', 'desktop-runtime'),
      }),
      /Desktop plugin (?:main|panel) entrypoint/iu,
    );
  });
}

test('derives builtin Kit layouts, windows, plugin outputs, and public assets from manifests', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  const outputRoot = path.join(repositoryRoot, 'dist', 'desktop-runtime');
  await updateJson(repositoryRoot, 'kits/default/package.json', (manifest) => {
    manifest['ce-editor'].kit.layouts = {
      default: 'layouts/custom.json',
      compact: 'layouts/compact.json',
    };
    manifest['ce-editor'].kit.windowEntries = {
      main: 'windows/application.html',
      secondary: 'windows/tool.html',
    };
  });
  await write(repositoryRoot, 'kits/default/layouts/custom.json', '{"name":"custom"}');
  await write(repositoryRoot, 'kits/default/layouts/compact.json', '{"name":"compact"}');
  await write(repositoryRoot, 'kits/default/windows/application.html', '<main>application</main>');
  await write(repositoryRoot, 'kits/default/windows/tool.html', '<main>tool</main>');
  await updateJson(repositoryRoot, 'kits/default/plugins/fixture-plugin/package.json', (manifest) => {
    manifest['ce-editor'].assets = { public: ['./assets/public'] };
  });
  await write(
    repositoryRoot,
    'kits/default/plugins/fixture-plugin/assets/public/logo.svg',
    '<svg></svg>',
  );

  await buildDesktop({ repositoryRoot, outputRoot });

  for (const relative of [
    'kits/default/layouts/custom.json',
    'kits/default/layouts/compact.json',
    'kits/default/windows/application.html',
    'kits/default/windows/tool.html',
    'kits/default/plugins/fixture-plugin/main/dist/index.js',
    'kits/default/plugins/fixture-plugin/panel.fixture/dist/index.html',
    'kits/default/plugins/fixture-plugin/assets/public/logo.svg',
  ]) assert.equal(existsSync(path.join(outputRoot, relative)), true, relative);
  for (const relative of [
    'kits/default/layout.json',
    'kits/default/main.html',
    'kits/default/secondary.html',
  ]) assert.equal(existsSync(path.join(outputRoot, relative)), false, relative);
});

test('rejects malformed builtin payload declarations before replacing output', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  const outputRoot = path.join(repositoryRoot, 'dist', 'desktop-runtime');
  await write(repositoryRoot, 'dist/desktop-runtime/sentinel.txt', 'previous');
  await updateJson(repositoryRoot, 'kits/default/package.json', (manifest) => {
    delete manifest['ce-editor'].kit.windowEntries.secondary;
  });

  await assert.rejects(
    buildDesktop({ repositoryRoot, outputRoot }),
    /builtin Kit.*windowEntries\.secondary/iu,
  );
  assert.equal(await readFile(path.join(outputRoot, 'sentinel.txt'), 'utf8'), 'previous');
});

test('rejects missing or malformed declared plugin public asset roots', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  const outputRoot = path.join(repositoryRoot, 'dist', 'desktop-runtime');
  await updateJson(repositoryRoot, 'kits/default/plugins/fixture-plugin/package.json', (manifest) => {
    manifest['ce-editor'].assets = { public: ['./assets/missing'] };
  });

  await assert.rejects(
    buildDesktop({ repositoryRoot, outputRoot }),
    /public asset/iu,
  );

  await updateJson(repositoryRoot, 'kits/default/plugins/fixture-plugin/package.json', (manifest) => {
    manifest['ce-editor'].assets = null;
  });
  await assert.rejects(
    buildDesktop({ repositoryRoot, outputRoot }),
    /public asset roots are malformed/iu,
  );
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
    entries: [{ source: 'kits/csv/package.json', destination: 'kits/csv/package.json' }],
  }), /product Kit/iu);
  await assert.rejects(stageDesktopFiles({
    repositoryRoot,
    outputRoot,
    entries: [{ source: 'kits/mysql/package.json', destination: 'kits/mysql/package.json' }],
  }), /product Kit/iu);
});

test('rejects recursive staging from the Kits root before writing product Kit descendants', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  const outputRoot = path.join(repositoryRoot, 'dist', 'kit-root-stage');
  await write(repositoryRoot, 'kits/csv/secret.txt', 'secret');

  await assert.rejects(stageDesktopFiles({
    repositoryRoot,
    outputRoot,
    entries: [{ source: 'kits', destination: 'kits', recursive: true }],
  }), /Kit root|product Kit/iu);
  assert.equal(existsSync(outputRoot), false);
});

test('rejects portable source aliases and destination identity collisions before writing', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  const source = 'kits/default/package.json';
  await write(repositoryRoot, 'kits/csv/package.json', '{}');
  const cases = [
    {
      name: 'case-aliased non-builtin source',
      entries: [{ source: 'KITS/csv/package.json', destination: 'kits/csv/package.json' }],
      error: /source spelling alias|product Kit/iu,
    },
    {
      name: 'separator-aliased non-builtin source',
      entries: [{ source: 'kits//csv/package.json', destination: 'kits/csv/package.json' }],
      error: /source spelling alias/iu,
    },
    {
      name: 'case-equivalent destinations',
      entries: [
        { source, destination: 'Case/manifest.json' },
        { source, destination: 'case/manifest.json' },
      ],
      error: /destination collision/iu,
    },
    {
      name: 'Unicode-equivalent destinations',
      entries: [
        { source, destination: 'unicode/caf\u00e9.json' },
        { source, destination: 'unicode/cafe\u0301.json' },
      ],
      error: /destination collision/iu,
    },
    {
      name: 'full-case-fold expansion-equivalent destinations',
      entries: [
        { source, destination: 'fold/straße.json' },
        { source, destination: 'fold/STRASSE.json' },
      ],
      error: /destination collision/iu,
    },
    {
      name: 'full-case-fold special-letter-equivalent destinations',
      entries: [
        { source, destination: 'fold/ς.json' },
        { source, destination: 'fold/σ.json' },
      ],
      error: /destination collision/iu,
    },
    {
      name: 'Unicode 16 Garay case-fold-equivalent destinations',
      entries: [
        { source, destination: 'fold/\u{10d50}.json' },
        { source, destination: 'fold/\u{10d70}.json' },
      ],
      error: /destination collision/iu,
    },
    {
      name: 'supplementary-plane Deseret case-fold-equivalent destinations',
      entries: [
        { source, destination: 'fold/\u{10400}.json' },
        { source, destination: 'fold/\u{10428}.json' },
      ],
      error: /destination collision/iu,
    },
    {
      name: 'file and directory prefix destinations',
      entries: [
        { source, destination: 'prefix/node' },
        { source, destination: 'prefix/node/child.json' },
      ],
      error: /destination collision/iu,
    },
  ];

  for (const [index, fixture] of cases.entries()) {
    await t.test(fixture.name, async () => {
      const outputRoot = path.join(repositoryRoot, 'dist', `portable-collision-${index}`);
      await assert.rejects(stageDesktopFiles({
        repositoryRoot,
        outputRoot,
        entries: fixture.entries,
      }), fixture.error);
      assert.equal(existsSync(outputRoot), false);
    });
  }
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
