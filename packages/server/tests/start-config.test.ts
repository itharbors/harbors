import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDataDir, resolveStartConfig } from '../src/start-config';

describe('resolveStartConfig', () => {
  it('uses DB_PATH when provided, resolved to an absolute path', () => {
    const rootDir = '/project';
    const customDbPath = '/var/lib/harbors/custom.db';
    const config = resolveStartConfig(rootDir, { DB_PATH: customDbPath });
    expect(config.dbPath).toBe(customDbPath);
    expect(path.isAbsolute(config.dbPath)).toBe(true);
  });

  it('resolves a relative DB_PATH against process.cwd()', () => {
    const rootDir = '/project';
    const config = resolveStartConfig(rootDir, { DB_PATH: 'relative.db' });
    expect(config.dbPath).toBe(path.resolve("relative.db"));
  });

  it('defaults dbPath to a stable file inside the project data directory', () => {
    const rootDir = '/project';
    const config = resolveStartConfig(rootDir, {});
    expect(config.dataDir).toBe(path.join(rootDir, ".data"));
    expect(config.dbPath).toBe(path.join(rootDir, ".data", "harbors.db"));
  });

  it('resolves config storage under the injected user home directory', () => {
    const config = resolveStartConfig('/project', {}, '/users/tester');
    expect(config.configDataDir).toBe('/users/tester/.harbors');
  });

  it('falls back to the default dbPath when DB_PATH is an empty string', () => {
    const rootDir = '/project';
    const config = resolveStartConfig(rootDir, { DB_PATH: "" });
    expect(config.dbPath).toBe(path.join(rootDir, ".data", "harbors.db"));
  });

  it('resolves port and host from env with defaults', () => {
    expect(resolveStartConfig('/project', {}).port).toBe(48381);
    expect(resolveStartConfig('/project', {}).host).toBe('0.0.0.0');
    expect(resolveStartConfig('/project', { HARBORS_SERVER_PORT: '9000' }).port).toBe(9000);
    expect(resolveStartConfig('/project', { HARBORS_BIND_HOST: '127.0.0.1' }).host).toBe('127.0.0.1');
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
    const dataDir = path.join(tmpDir, '.data', 'nested', 'deep');
    expect(fs.existsSync(dataDir)).toBe(false);
    await ensureDataDir(dataDir);
    expect(fs.existsSync(dataDir)).toBe(true);
    expect(fs.statSync(dataDir).isDirectory()).toBe(true);
  });

  it('is idempotent when the directory already exists', async () => {
    const dataDir = path.join(tmpDir, '.data');
    fs.mkdirSync(dataDir, { recursive: true });
    await expect(ensureDataDir(dataDir)).resolves.toBeUndefined();
    expect(fs.existsSync(dataDir)).toBe(true);
  });
});
