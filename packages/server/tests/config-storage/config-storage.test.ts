import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { ConfigLayerDefinition, ConfigStorage } from '@itharbors/kit-core';
import {
  CONFIG_STORAGE_CORRUPT,
  CONFIG_STORAGE_CLOSED,
  ConfigStorageCorruptError,
  ConfigStorageClosedError,
  resolveConfigLayerBackend,
} from '../../src/config-storage';

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harbors-config-storage-'));
  temporaryDirectories.push(root);
  return root;
}

function sqliteLayer(name = 'global', storage: ConfigStorage = {
  driver: 'sqlite',
  root: 'application-data',
  path: 'config.sqlite',
}): ConfigLayerDefinition {
  return { name, priority: 10, storage };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe('config storage resolver', () => {
  it('creates isolated in-memory backends for null storage', () => {
    const root = temporaryRoot();
    const layer = sqliteLayer('defaults', null);
    const first = resolveConfigLayerBackend('kit-a', layer, { roots: { 'application-data': root } });
    const second = resolveConfigLayerBackend('kit-a', layer, { roots: { 'application-data': root } });

    first.set('theme', 'dark');
    expect(first.get('theme')).toBe('dark');
    expect(second.get('theme')).toBeUndefined();
    first.destroy?.();
    second.destroy?.();
  });

  it('persists JSON values and supports a root-level SQLite file', () => {
    const root = temporaryRoot();
    const layer = sqliteLayer();
    const first = resolveConfigLayerBackend('kit-a', layer, { roots: { 'application-data': root } });
    first.set('value', { enabled: true, count: 2, items: [null, 'x'] });
    first.destroy?.();

    const second = resolveConfigLayerBackend('kit-a', layer, { roots: { 'application-data': root } });
    expect(second.get('value')).toEqual({ enabled: true, count: 2, items: [null, 'x'] });
    expect(fs.existsSync(path.join(root, 'config.sqlite'))).toBe(true);
    second.destroy?.();
  });

  it('shares the same Kit layer across instances but isolates Kit and layer namespaces', () => {
    const root = temporaryRoot();
    const layer = sqliteLayer();
    const sameKit = resolveConfigLayerBackend('kit-a', layer, { roots: { 'application-data': root } });
    const otherInstance = resolveConfigLayerBackend('kit-a', layer, { roots: { 'application-data': root } });
    const otherKit = resolveConfigLayerBackend('kit-b', layer, { roots: { 'application-data': root } });
    const otherLayer = resolveConfigLayerBackend('kit-a', sqliteLayer('other'), { roots: { 'application-data': root } });

    sameKit.set('owner', 'kit-a');
    expect(otherInstance.get('owner')).toBe('kit-a');
    expect(otherKit.get('owner')).toBeUndefined();
    expect(otherLayer.get('owner')).toBeUndefined();

    sameKit.destroy?.();
    otherInstance.destroy?.();
    otherKit.destroy?.();
    otherLayer.destroy?.();
  });

  it('isolates the plugin namespace in the SQLite four-part key', () => {
    const root = temporaryRoot();
    const layer = sqliteLayer();
    const first = resolveConfigLayerBackend('kit-a', layer, { roots: { 'application-data': root } });
    const second = resolveConfigLayerBackend('kit-a', layer, { roots: { 'application-data': root } });
    first.set('shared', 'first', 'plugin-a');
    second.set('shared', 'second', 'plugin-b');

    expect(first.get('shared', 'plugin-a')).toBe('first');
    expect(first.get('shared', 'plugin-b')).toBe('second');
    expect(first.get('shared')).toBeUndefined();

    first.destroy?.();
    second.destroy?.();
    const database = new Database(path.join(root, 'config.sqlite'), { readonly: true });
    expect(database.prepare('SELECT kit_id, plugin_name, layer_name, key FROM config_values ORDER BY plugin_name').all())
      .toEqual([
        { kit_id: 'kit-a', plugin_name: 'plugin-a', layer_name: 'global', key: 'shared' },
        { kit_id: 'kit-a', plugin_name: 'plugin-b', layer_name: 'global', key: 'shared' },
      ]);
    database.close();
  });

  it('migrates legacy rows without deleting them and is idempotent', () => {
    const root = temporaryRoot();
    const databasePath = path.join(root, 'config.sqlite');
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE config_values (
        kit_id TEXT NOT NULL,
        layer_name TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        PRIMARY KEY (kit_id, layer_name, key)
      );
    `);
    database.prepare('INSERT INTO config_values VALUES (?, ?, ?, ?)')
      .run('kit-a', 'global', 'legacy', JSON.stringify({ preserved: true }));
    database.close();

    const first = resolveConfigLayerBackend('kit-a', sqliteLayer(), { roots: { 'application-data': root } });
    expect(first.get('legacy')).toEqual({ preserved: true });
    first.destroy?.();
    const second = resolveConfigLayerBackend('kit-a', sqliteLayer(), { roots: { 'application-data': root } });
    expect(second.get('legacy')).toEqual({ preserved: true });
    second.destroy?.();

    const reopened = new Database(databasePath, { readonly: true });
    expect(reopened.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'config_values_legacy'").get())
      .toEqual({ count: 1 });
    expect(reopened.prepare('SELECT COUNT(*) AS count FROM config_values WHERE kit_id = ? AND plugin_name = ?').get('kit-a', ''))
      .toEqual({ count: 1 });
    reopened.close();
  });

  it('copies ordered legacy Kit namespaces with current values taking precedence', () => {
    const root = temporaryRoot();
    const layer = sqliteLayer();
    const firstLegacy = resolveConfigLayerBackend('kit-old-a', layer, { roots: { 'application-data': root } });
    firstLegacy.set('from-a', 'old-a', 'plugin');
    firstLegacy.set('shared', 'old-a-wins', 'plugin');
    firstLegacy.destroy?.();
    const secondLegacy = resolveConfigLayerBackend('kit-old-b', layer, { roots: { 'application-data': root } });
    secondLegacy.set('from-b', 'old-b', 'plugin');
    secondLegacy.set('shared', 'old-b-loses', 'plugin');
    secondLegacy.destroy?.();
    const current = resolveConfigLayerBackend('kit-new', layer, { roots: { 'application-data': root } });
    current.set('shared', 'new-wins', 'plugin');
    current.destroy?.();

    const migrated = resolveConfigLayerBackend(
      'kit-new',
      layer,
      { roots: { 'application-data': root } },
      ['kit-old-a', 'kit-old-b'],
    );
    expect(migrated.get('from-a', 'plugin')).toBe('old-a');
    expect(migrated.get('from-b', 'plugin')).toBe('old-b');
    expect(migrated.get('shared', 'plugin')).toBe('new-wins');
    migrated.destroy?.();

    const database = new Database(path.join(root, 'config.sqlite'), { readonly: true });
    expect(database.prepare('SELECT value_json FROM config_values WHERE kit_id = ? AND key = ?')
      .get('kit-old-a', 'shared')).toEqual({ value_json: JSON.stringify('old-a-wins') });
    expect(database.prepare('SELECT COUNT(*) AS count FROM config_values WHERE kit_id = ?')
      .get('kit-new')).toEqual({ count: 3 });
    database.close();

    const retried = resolveConfigLayerBackend(
      'kit-new',
      layer,
      { roots: { 'application-data': root } },
      ['kit-old-a', 'kit-old-b'],
    );
    expect(retried.get('shared', 'plugin')).toBe('new-wins');
    retried.destroy?.();
  });

  it('uses WAL mode', () => {
    const root = temporaryRoot();
    const layer = sqliteLayer();
    const backend = resolveConfigLayerBackend('kit-a', layer, { roots: { 'application-data': root } });
    backend.set('key', 'value');
    backend.destroy?.();
    const database = new Database(path.join(root, 'config.sqlite'), { readonly: true });
    expect(database.pragma('journal_mode', { simple: true })).toBe('wal');
    database.close();
  });

  it('fails closed on corrupted JSON rows', () => {
    const root = temporaryRoot();
    const layer = sqliteLayer();
    const backend = resolveConfigLayerBackend('kit-a', layer, { roots: { 'application-data': root } });
    backend.destroy?.();
    const database = new Database(path.join(root, 'config.sqlite'));
    database.prepare('INSERT INTO config_values (kit_id, plugin_name, layer_name, key, value_json) VALUES (?, ?, ?, ?, ?)')
      .run('kit-a', '', 'global', 'broken', '{not-json');
    database.close();

    const reopened = resolveConfigLayerBackend('kit-a', layer, { roots: { 'application-data': root } });
    expect(() => reopened.get('broken')).toThrow(ConfigStorageCorruptError);
    try {
      reopened.get('broken');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigStorageCorruptError);
      expect((error as ConfigStorageCorruptError).code).toBe(CONFIG_STORAGE_CORRUPT);
    }
    reopened.destroy?.();
  });

  it('rejects paths outside the controlled application-data root', () => {
    const root = temporaryRoot();
    expect(() => resolveConfigLayerBackend('kit-a', sqliteLayer('global', {
      driver: 'sqlite',
      root: 'application-data',
      path: '../outside.sqlite',
    }), { roots: { 'application-data': root } })).toThrow(/relative|outside|path/i);
    expect(() => resolveConfigLayerBackend('kit-a', sqliteLayer('global', {
      driver: 'sqlite',
      root: 'application-data',
      path: '/outside.sqlite',
    }), { roots: { 'application-data': root } })).toThrow(/relative|outside|path/i);
  });

  it('closes without deleting persisted data', () => {
    const root = temporaryRoot();
    const layer = sqliteLayer();
    const backend = resolveConfigLayerBackend('kit-a', layer, { roots: { 'application-data': root } });
    backend.set('key', 'value');
    backend.destroy?.();
    expect(() => backend.get('key')).toThrow(ConfigStorageClosedError);
    try {
      backend.get('key');
    } catch (error) {
      expect((error as ConfigStorageClosedError).code).toBe(CONFIG_STORAGE_CLOSED);
    }
    const reopened = resolveConfigLayerBackend('kit-a', layer, { roots: { 'application-data': root } });
    expect(reopened.get('key')).toBe('value');
    reopened.destroy?.();
  });
});
