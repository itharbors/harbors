import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveKit, resolvePlugin } from '../../src/plugin/resolver';
import type { KitResolveContext, PluginResolveContext } from '../../src/plugin/resolver';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('resolvePlugin', () => {
  let projectRoot: string;
  let pluginsDir: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-resolver-'));
    pluginsDir = path.join(projectRoot, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function createPlugin(dirName: string, pkgName: string): string {
    const dir = path.join(pluginsDir, dirName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: pkgName,
      main: 'index.js',
      'ce-editor': { contribute: {} },
    }));
    fs.writeFileSync(path.join(dir, 'index.js'), '');
    return dir;
  }

  function createKitPlugin(kitName: string, dirName: string, pkgName: string): string {
    const dir = path.join(projectRoot, 'kits', kitName, 'plugins', dirName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: pkgName,
      main: 'index.js',
      'ce-editor': { contribute: {} },
    }));
    fs.writeFileSync(path.join(dir, 'index.js'), '');
    return dir;
  }

  function pluginContext(activeKitPluginsDir: string | null = null): PluginResolveContext {
    return {
      builtinPluginsDir: path.join(projectRoot, 'builtin-plugins'),
      pluginsDir,
      activeKitPluginsDir,
    };
  }

  function kitContext(): KitResolveContext {
    return {
      builtinKitsDir: path.join(projectRoot, 'builtin-kits'),
      kitsDir: path.join(projectRoot, 'kits'),
    };
  }

  it('finds a plugin by name in plugins/ directory', async () => {
    const dir = createPlugin('code-editor', '@scope/code-editor');

    const result = await resolvePlugin('@scope/code-editor', pluginContext());

    expect(result).toBe(dir);
  });

  it('finds a plugin bundled under kits/*/plugins', async () => {
    const dir = createKitPlugin('default', 'status-bar', '@scope/status-bar');

    const result = await resolvePlugin('@scope/status-bar', pluginContext(path.join(projectRoot, 'kits', 'default', 'plugins')));

    expect(result).toBe(dir);
  });

  it('does not fall back to node_modules when explicit directories do not contain the plugin', async () => {
    const nodeModulesDir = path.join(projectRoot, 'node_modules', '@scope', 'nm-plugin');
    fs.mkdirSync(path.join(nodeModulesDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(nodeModulesDir, 'package.json'), JSON.stringify({
      name: '@scope/nm-plugin',
      main: 'dist/index.js',
      'ce-editor': { contribute: {} },
    }));
    fs.writeFileSync(path.join(nodeModulesDir, 'dist', 'index.js'), '');
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'test-project' }));

    await expect(resolvePlugin('@scope/nm-plugin', pluginContext()))
      .rejects.toThrow(/not found/);
  });

  it('throws when plugin not found', async () => {
    await expect(resolvePlugin('@scope/nonexistent', pluginContext()))
      .rejects.toThrow(/not found/);
  });

  it('throws when plugins/ directory is missing', async () => {
    // Remove the plugins directory so it doesn't exist
    fs.rmSync(pluginsDir, { recursive: true, force: true });

    await expect(resolvePlugin('@scope/nonexistent', pluginContext()))
      .rejects.toThrow(/not found/);
  });

  it('skips directories without ce-editor field', async () => {
    const dir = path.join(pluginsDir, 'not-a-plugin');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: '@scope/not-a-plugin',
    }));

    await expect(resolvePlugin('@scope/not-a-plugin', pluginContext()))
      .rejects.toThrow(/not found/);
  });

  it('finds a kit by name in kits/ directory', async () => {
    const kitDir = path.join(projectRoot, 'kits', 'default');
    fs.mkdirSync(kitDir, { recursive: true });
    fs.writeFileSync(path.join(kitDir, 'package.json'), JSON.stringify({
      name: '@scope/kit-default',
      'ce-editor': { kit: { layouts: { default: 'layout.json' }, plugin: [] } },
    }));

    await expect(resolveKit('@scope/kit-default', kitContext())).resolves.toBe(kitDir);
  });
});
