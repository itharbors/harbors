import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { discoverAllPlugins, discoverPlugin, discoverRuntimePlugins } from './discover.mjs';

function writePackageJson(pluginDir, packageJson) {
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'package.json'), packageJson);
}

test('runtime discovery includes framework and declared builtin Kit plugins only', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbors-plugin-discovery-'));
  try {
    writePackageJson(path.join(rootDir, 'plugins/menu'), JSON.stringify({ name: 'menu' }));
    writePackageJson(path.join(rootDir, 'kits/default/plugins/log'), JSON.stringify({ name: 'log' }));
    const brokenPluginDir = path.join(rootDir, 'kits/broken/plugins/failure');
    writePackageJson(brokenPluginDir, '{ not valid JSON');

    assert.deepEqual(
      discoverRuntimePlugins(rootDir).map((item) => path.relative(rootDir, item)),
      ['kits/default/plugins/log', 'plugins/menu'],
    );
    assert.deepEqual(
      discoverAllPlugins(rootDir).map((item) => path.relative(rootDir, item)),
      ['kits/broken/plugins/failure', 'kits/default/plugins/log', 'plugins/menu'],
    );
    assert.throws(() => discoverPlugin(brokenPluginDir));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
