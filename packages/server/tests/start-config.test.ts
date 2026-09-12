import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDataDir, resolveStartConfig } from '../src/start-config';
import { applyStartArgumentsToEnv, parseStartArguments } from '../src/start-args';

describe('resolveStartConfig', () => {
  it('uses DB_PATH when provided, resolved to an absolute path', () => {
    const customDbPath = '/var/lib/harbors/custom.db';
    const config = resolveStartConfig({ DB_PATH: customDbPath });
    expect(config.dbPath).toBe(customDbPath);
    expect(path.isAbsolute(config.dbPath)).toBe(true);
    expect(config.applicationDataDir).toBe(path.join(os.homedir(), '.harbors'));
  });

  it('resolves a relative DB_PATH against process.cwd()', () => {
    const config = resolveStartConfig({ DB_PATH: 'relative.db' });
    expect(config.dbPath).toBe(path.resolve("relative.db"));
  });

  it('defaults all persistent roots to the injected user application data directory', () => {
    const config = resolveStartConfig({}, '/users/tester');
    expect(config.applicationDataDir).toBe('/users/tester/.harbors');
    expect(config.configDataDir).toBe('/users/tester/.harbors');
    expect(config.dbPath).toBe('/users/tester/.harbors/harbors.db');
    expect(config.pluginPathRoots).toEqual({
      applicationData: '/users/tester/.harbors',
      data: '/users/tester/.harbors/plugins/data',
      cache: '/users/tester/.harbors/plugins/cache',
      temp: '/users/tester/.harbors/plugins/temp',
    });
  });

  it('moves every persistent root together with HARBORS_DATA_ROOT', () => {
    const config = resolveStartConfig({ HARBORS_DATA_ROOT: '/srv/harbors-alpha' }, '/users/tester');
    expect(config.applicationDataDir).toBe('/srv/harbors-alpha');
    expect(config.configDataDir).toBe('/srv/harbors-alpha');
    expect(config.dbPath).toBe('/srv/harbors-alpha/harbors.db');
    expect(config.pluginPathRoots).toEqual({
      applicationData: '/srv/harbors-alpha',
      data: '/srv/harbors-alpha/plugins/data',
      cache: '/srv/harbors-alpha/plugins/cache',
      temp: '/srv/harbors-alpha/plugins/temp',
    });
  });

  it('rejects a relative HARBORS_DATA_ROOT', () => {
    expect(() => resolveStartConfig({ HARBORS_DATA_ROOT: 'relative' }, '/users/tester'))
      .toThrow(/HARBORS_DATA_ROOT.*absolute/u);
  });

  it('keeps component overrides above the unified data root', () => {
    const config = resolveStartConfig({
      HARBORS_DATA_ROOT: '/srv/harbors-alpha',
      DB_PATH: '/srv/harbors-alpha/custom.db',
      HARBORS_PLUGIN_DATA_ROOT: '/srv/harbors-alpha/custom-plugin-data',
    }, '/users/tester');
    expect(config.dbPath).toBe('/srv/harbors-alpha/custom.db');
    expect(config.pluginPathRoots.data).toBe('/srv/harbors-alpha/custom-plugin-data');
    expect(config.pluginPathRoots.cache).toBe('/srv/harbors-alpha/plugins/cache');
  });

  it('resolves config storage under the injected user home directory', () => {
    const config = resolveStartConfig({}, '/users/tester');
    expect(config.configDataDir).toBe('/users/tester/.harbors');
  });

  it('falls back to the default dbPath when DB_PATH is an empty string', () => {
    const config = resolveStartConfig({ DB_PATH: "" }, '/users/tester');
    expect(config.dbPath).toBe('/users/tester/.harbors/harbors.db');
  });

  it('resolves port and host from env with defaults', () => {
    expect(resolveStartConfig({}).port).toBe(48381);
    expect(resolveStartConfig({}).host).toBe('0.0.0.0');
    expect(resolveStartConfig({ HARBORS_SERVER_PORT: '9000' }).port).toBe(9000);
    expect(resolveStartConfig({ PORT: '9001', HARBORS_SERVER_PORT: '9000' }).port).toBe(9001);
    expect(resolveStartConfig({ HARBORS_BIND_HOST: '127.0.0.1' }).host).toBe('127.0.0.1');
  });

  it('requires explicit Plugin root overrides to be absolute and keeps DB_PATH independent', () => {
    expect(() => resolveStartConfig({ HARBORS_PLUGIN_DATA_ROOT: 'relative' }, '/users/tester'))
      .toThrow(/HARBORS_PLUGIN_DATA_ROOT.*absolute/u);
    const config = resolveStartConfig({
      DB_PATH: '/custom/server.db',
      HARBORS_PLUGIN_DATA_ROOT: '/users/tester/.harbors/custom-data',
    }, '/users/tester');
    expect(config.dbPath).toBe('/custom/server.db');
    expect(config.pluginPathRoots.applicationData).toBe('/users/tester/.harbors');
    expect(config.pluginPathRoots.data).toBe('/users/tester/.harbors/custom-data');
  });
});

describe('parseStartArguments', () => {
  it('accepts both data-root forms and canonicalizes the value', () => {
    expect(parseStartArguments(['--data-root', '/srv/data/../harbors']).dataRoot).toBe('/srv/harbors');
    expect(parseStartArguments(['--data-root=/srv/harbors']).dataRoot).toBe('/srv/harbors');
  });

  it('supports the pnpm separator and help', () => {
    expect(parseStartArguments(['--', '--help'])).toEqual({ dataRoot: undefined, help: true });
  });

  it('rejects relative, missing, duplicate, and unknown arguments', () => {
    expect(() => parseStartArguments(['--data-root', 'relative'])).toThrow(/absolute/u);
    expect(() => parseStartArguments(['--data-root'])).toThrow(/requires/u);
    expect(() => parseStartArguments(['--data-root=/one', '--data-root=/two'])).toThrow(/once/u);
    expect(() => parseStartArguments(['--unknown'])).toThrow(/Unknown start argument/u);
  });

  it('applies a CLI data root over the inherited environment for child processes', () => {
    const env = { HARBORS_DATA_ROOT: '/old/root', KEEP: 'value' };
    expect(applyStartArgumentsToEnv(env, parseStartArguments(['--data-root=/new/root']))).toBe(env);
    expect(env).toEqual({ HARBORS_DATA_ROOT: '/new/root', KEEP: 'value' });
  });
});

describe('ensureDataDir', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbors-start-config-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the data directory recursively when it does not exist', async () => {
    const dataDir = path.join(tmpDir, '.harbors', 'nested', 'deep');
    expect(fs.existsSync(dataDir)).toBe(false);
    await ensureDataDir(dataDir);
    expect(fs.existsSync(dataDir)).toBe(true);
    expect(fs.statSync(dataDir).isDirectory()).toBe(true);
  });

  it('is idempotent when the directory already exists', async () => {
    const dataDir = path.join(tmpDir, '.harbors');
    fs.mkdirSync(dataDir, { recursive: true });
    await expect(ensureDataDir(dataDir)).resolves.toBeUndefined();
    expect(fs.existsSync(dataDir)).toBe(true);
  });
});
