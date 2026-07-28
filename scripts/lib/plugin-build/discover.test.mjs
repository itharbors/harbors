import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { discoverAllPlugins, discoverPlugin, discoverRuntimePlugins } from './discover.mjs';

function createRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harbors-plugin-discovery-'));
}

function writePackageJson(pluginDir, packageJson) {
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'package.json'), packageJson);
}

function writeBuiltinKit(rootDir, { ordinary = [], startup = [] } = {}) {
  const kitDir = path.join(rootDir, 'kits/default');
  fs.mkdirSync(kitDir, { recursive: true });
  fs.writeFileSync(path.join(kitDir, 'package.json'), JSON.stringify({
    name: '@itharbors/kit-default',
    'ce-editor': {
      kit: {
        layouts: { default: 'layout.json' },
        windowEntries: { main: 'main.html', secondary: 'secondary.html' },
        plugin: ordinary,
        startup: { plugins: startup },
      },
    },
  }));
}

function relativePlugins(rootDir, plugins) {
  return plugins.map((item) => path.relative(rootDir, item));
}

test('runtime discovery reconciles ordinary and startup declarations in deterministic order', () => {
  const rootDir = createRoot();
  try {
    writePackageJson(path.join(rootDir, 'plugins/menu'), JSON.stringify({ name: '@itharbors/menu' }));
    writeBuiltinKit(rootDir, {
      ordinary: ['@fixture/log'],
      startup: ['@fixture/background'],
    });
    writePackageJson(
      path.join(rootDir, 'kits/default/plugins/z-log'),
      JSON.stringify({ name: '@fixture/log' }),
    );
    writePackageJson(
      path.join(rootDir, 'kits/default/plugins/a-background'),
      JSON.stringify({ name: '@fixture/background' }),
    );
    const brokenPluginDir = path.join(rootDir, 'kits/broken/plugins/failure');
    writePackageJson(brokenPluginDir, '{ not valid JSON');

    assert.deepEqual(relativePlugins(rootDir, discoverRuntimePlugins(rootDir)), [
      'kits/default/plugins/a-background',
      'kits/default/plugins/z-log',
      'plugins/menu',
    ]);
    assert.deepEqual(relativePlugins(rootDir, discoverAllPlugins(rootDir)), [
      'kits/broken/plugins/failure',
      'kits/default/plugins/a-background',
      'kits/default/plugins/z-log',
      'plugins/menu',
    ]);
    assert.throws(() => discoverPlugin(brokenPluginDir));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('runtime discovery rejects a missing declared builtin plugin', () => {
  const rootDir = createRoot();
  try {
    writeBuiltinKit(rootDir, { ordinary: ['@fixture/missing'] });
    assert.throws(
      () => discoverRuntimePlugins(rootDir),
      /missing declared plugin.*@fixture\/missing/iu,
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('runtime discovery rejects a mismatched builtin plugin package', () => {
  const rootDir = createRoot();
  try {
    writeBuiltinKit(rootDir, { ordinary: ['@fixture/expected'] });
    writePackageJson(
      path.join(rootDir, 'kits/default/plugins/expected'),
      JSON.stringify({ name: '@fixture/other' }),
    );
    assert.throws(
      () => discoverRuntimePlugins(rootDir),
      /undeclared plugin.*@fixture\/other|mismatch/iu,
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('runtime discovery rejects duplicate directories for one declared plugin', () => {
  const rootDir = createRoot();
  try {
    writeBuiltinKit(rootDir, { ordinary: ['@fixture/duplicate'] });
    for (const directory of ['first', 'second']) {
      writePackageJson(
        path.join(rootDir, 'kits/default/plugins', directory),
        JSON.stringify({ name: '@fixture/duplicate' }),
      );
    }
    assert.throws(
      () => discoverRuntimePlugins(rootDir),
      /duplicate.*@fixture\/duplicate/iu,
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('runtime discovery rejects ordinary and startup declaration overlap', () => {
  const rootDir = createRoot();
  try {
    writeBuiltinKit(rootDir, {
      ordinary: ['@fixture/overlap'],
      startup: ['@fixture/overlap'],
    });
    writePackageJson(
      path.join(rootDir, 'kits/default/plugins/overlap'),
      JSON.stringify({ name: '@fixture/overlap' }),
    );
    assert.throws(() => discoverRuntimePlugins(rootDir), /ordinary and startup|overlap/iu);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('runtime discovery rejects undeclared and invalid builtin plugin directories', async (t) => {
  await t.test('undeclared package', () => {
    const rootDir = createRoot();
    try {
      writeBuiltinKit(rootDir);
      writePackageJson(
        path.join(rootDir, 'kits/default/plugins/extra'),
        JSON.stringify({ name: '@fixture/extra' }),
      );
      assert.throws(() => discoverRuntimePlugins(rootDir), /undeclared plugin.*@fixture\/extra/iu);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
  await t.test('invalid package manifest', () => {
    const rootDir = createRoot();
    try {
      writeBuiltinKit(rootDir, { ordinary: ['@fixture/invalid'] });
      writePackageJson(path.join(rootDir, 'kits/default/plugins/invalid'), '{ bad json');
      assert.throws(() => discoverRuntimePlugins(rootDir), /invalid builtin plugin|JSON/iu);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
