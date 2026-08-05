import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  resolveApplicationPluginRunner,
  spawnApplicationPluginProcess,
  type ResolvedApplicationPluginRunner,
} from '../../src/application/plugin-process/spawn';

function fakeChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: PassThrough;
    stderr: PassThrough;
    send: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = 43210;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.send = vi.fn(() => true);
  child.kill = vi.fn(() => true);
  return child;
}

describe('application plugin process runner resolution', () => {
  it('uses the local tsx loader for the source runner', () => {
    const resolved = resolveApplicationPluginRunner(
      'file:///workspace/harbors/packages/server/src/application/plugin-process/spawn.ts',
    );

    expect(resolved).toEqual({
      executable: process.execPath,
      args: [
        '--import',
        expect.stringMatching(/tsx\/dist\/loader\.mjs$/u),
        '/workspace/harbors/packages/server/src/application/plugin-process/runner.ts',
      ],
      runtimeMode: 'node',
    });
  });

  it('uses the emitted JavaScript runner without a development loader', () => {
    const resolved = resolveApplicationPluginRunner(
      'file:///opt/harbors/packages/server/dist/application/plugin-process/spawn.js',
    );

    expect(resolved).toEqual({
      executable: process.execPath,
      args: ['/opt/harbors/packages/server/dist/application/plugin-process/runner.js'],
      runtimeMode: 'node',
    });
  });

  it('marks an Electron run-as-node resolver without changing its executable or arguments', () => {
    Object.defineProperty(process.versions, 'electron', {
      configurable: true,
      value: '43.2.0',
    });
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1');
    try {
      expect(resolveApplicationPluginRunner(
        'file:///Applications/ITHARBORS.app/Contents/Resources/runner/spawn.js',
      )).toEqual({
        executable: process.execPath,
        args: ['/Applications/ITHARBORS.app/Contents/Resources/runner/runner.js'],
        runtimeMode: 'electron-run-as-node',
      });
    } finally {
      delete process.versions.electron;
      vi.unstubAllEnvs();
    }
  });
});

describe('application plugin child adapter', () => {
  it('spawns the resolved runner in the Framework cwd with advanced IPC and a sanitized environment', () => {
    const rawChild = fakeChildProcess();
    const spawn = vi.fn(() => rawChild);
    const runner: ResolvedApplicationPluginRunner = {
      executable: '/usr/local/bin/node',
      args: ['--import', '/workspace/node_modules/tsx/dist/loader.mjs', '/workspace/runner.ts'],
      runtimeMode: 'node',
    };

    const child = spawnApplicationPluginProcess({
      runner,
      cwd: '/workspace/harbors',
      env: {
        PATH: '/usr/local/bin:/usr/bin',
        HOME: '/Users/me',
        USER: 'me',
        TMPDIR: '/tmp',
        LANG: 'zh_CN.UTF-8',
        LC_ALL: 'zh_CN.UTF-8',
        CODEX_HOME: '/Users/me/.codex',
        HARBORS_RUNTIME_PROFILE: 'development',
        HARBORS_CREDENTIAL_MODE: 'local',
        HARBORS_ALLOW_SECRET: '1',
        HARBORS_APPLICATION_TOKEN: 'application-secret',
        HARBORS_NOTIFICATION_PORT: '49123',
        HARBORS_NOTIFICATION_OWNER_TOKEN: 'notification-secret',
        HARBORS_CREDENTIAL_TRANSPORT_SECRET: 'credential-secret',
        CAPTURED_HOST_SECRET: 'captured-secret',
      },
      secretEnvironmentKeys: ['CAPTURED_HOST_SECRET'],
      spawn,
    });

    expect(spawn).toHaveBeenCalledWith(
      '/usr/local/bin/node',
      ['--import', '/workspace/node_modules/tsx/dist/loader.mjs', '/workspace/runner.ts'],
      {
        cwd: '/workspace/harbors',
        detached: false,
        env: {
          PATH: '/usr/local/bin:/usr/bin',
          HOME: '/Users/me',
          USER: 'me',
          TMPDIR: '/tmp',
          LANG: 'zh_CN.UTF-8',
          LC_ALL: 'zh_CN.UTF-8',
          CODEX_HOME: '/Users/me/.codex',
          HARBORS_RUNTIME_PROFILE: 'development',
          HARBORS_CREDENTIAL_MODE: 'local',
          HARBORS_ALLOW_SECRET: '1',
        },
        serialization: 'advanced',
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    expect(JSON.stringify(runner.args)).not.toContain('application-secret');
    expect(child.pid).toBe(43210);
    expect('stdout' in child).toBe(false);
    expect('stderr' in child).toBe(false);
  });

  it('enables Electron run-as-node only in the child environment', () => {
    const rawChild = fakeChildProcess();
    const spawn = vi.fn(() => rawChild);
    const runner: ResolvedApplicationPluginRunner = {
      executable: '/Applications/ITHARBORS.app/Contents/MacOS/ITHARBORS',
      args: ['/Applications/ITHARBORS.app/Contents/Resources/app.asar.unpacked/runner.js'],
      runtimeMode: 'electron-run-as-node',
    };

    spawnApplicationPluginProcess({
      runner,
      cwd: '/Applications/ITHARBORS.app/Contents/Resources/runtime',
      env: { PATH: '/usr/bin', HARBORS_RUNTIME_ROOT: '/runtime' },
      spawn,
    });

    expect(spawn).toHaveBeenCalledWith(
      runner.executable,
      runner.args,
      expect.objectContaining({
        cwd: '/Applications/ITHARBORS.app/Contents/Resources/runtime',
        env: {
          PATH: '/usr/bin',
          HARBORS_RUNTIME_ROOT: '/runtime',
          ELECTRON_RUN_AS_NODE: '1',
        },
      }),
    );
    expect(runner.args.join(' ')).not.toContain('ELECTRON_RUN_AS_NODE');
  });

  it('waits for a successful IPC callback after send reports backpressure', async () => {
    const rawChild = fakeChildProcess();
    let complete: ((error: Error | null) => void) | undefined;
    rawChild.send = vi.fn((_message, callback) => {
      complete = callback;
      return false;
    });
    const child = spawnApplicationPluginProcess({
      runner: { executable: '/node', args: ['/runner.js'], runtimeMode: 'node' },
      cwd: '/framework',
      env: {},
      spawn: () => rawChild,
    });

    const sent = child.send({ kind: 'request' });
    let settled = false;
    void sent.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    complete?.(null);
    await expect(sent).resolves.toBeUndefined();
  });

  it('exposes asynchronous IPC callback failures', async () => {
    const rawChild = fakeChildProcess();
    rawChild.send = vi.fn((_message, callback) => {
      callback(new Error('ipc queue closed'));
      return false;
    });
    const child = spawnApplicationPluginProcess({
      runner: { executable: '/node', args: ['/runner.js'], runtimeMode: 'node' },
      cwd: '/framework',
      env: {},
      spawn: () => rawChild,
    });

    const sent = child.send({ kind: 'request' });
    await expect(sent).rejects.toThrow('ipc queue closed');
  });

  it('exposes synchronous IPC send failures', async () => {
    const rawChild = fakeChildProcess();
    rawChild.send = vi.fn(() => { throw new Error('ipc disconnected'); });
    const child = spawnApplicationPluginProcess({
      runner: { executable: '/node', args: ['/runner.js'], runtimeMode: 'node' },
      cwd: '/framework',
      env: {},
      spawn: () => rawChild,
    });

    await expect(child.send({ kind: 'request' })).rejects.toThrow('ipc disconnected');
  });

  it('reports a real spawn ENOENT as one sanitized terminal event', async () => {
    const child = spawnApplicationPluginProcess({
      runner: {
        executable: `/definitely-missing-harbors-runner-${process.pid}`,
        args: ['/runner.js'],
        runtimeMode: 'node',
      },
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
    });

    const terminal = await new Promise<unknown>((resolve) => {
      child.subscribeExit(resolve);
    });
    expect(terminal).toMatchObject({
      kind: 'error',
      code: null,
      signal: null,
      error: { code: 'ENOENT', message: expect.any(String) },
    });
    expect((terminal as { error: object }).error).not.toHaveProperty('stack');
  }, 1_000);

  it('treats disconnect without exit as terminal and ignores a later exit', () => {
    const rawChild = fakeChildProcess();
    const child = spawnApplicationPluginProcess({
      runner: { executable: '/node', args: ['/runner.js'], runtimeMode: 'node' },
      cwd: '/framework',
      env: {},
      spawn: () => rawChild,
    });
    const terminals: unknown[] = [];
    child.subscribeExit((terminal) => terminals.push(terminal));

    rawChild.emit('disconnect');
    rawChild.emit('exit', 1, 'SIGTERM');

    expect(terminals).toEqual([{
      kind: 'disconnect', code: null, signal: null, error: null,
    }]);
  });

  it('replays a terminal event that raced ahead of subscription', () => {
    const rawChild = fakeChildProcess();
    const child = spawnApplicationPluginProcess({
      runner: { executable: '/node', args: ['/runner.js'], runtimeMode: 'node' },
      cwd: '/framework',
      env: {},
      spawn: () => rawChild,
    });
    rawChild.emit('disconnect');
    const terminals: unknown[] = [];

    child.subscribeExit((terminal) => terminals.push(terminal));

    expect(terminals).toEqual([{
      kind: 'disconnect', code: null, signal: null, error: null,
    }]);
  });

  it.each(['stdout', 'stderr'] as const)('contains %s stream errors and stops that tail capture', (streamName) => {
    const rawChild = fakeChildProcess();
    const child = spawnApplicationPluginProcess({
      runner: { executable: '/node', args: ['/runner.js'], runtimeMode: 'node' },
      cwd: '/framework',
      env: {},
      spawn: () => rawChild,
    });
    const stream = rawChild[streamName];
    stream.write('before-error');

    expect(() => stream.emit('error', new Error(`${streamName} failed`))).not.toThrow();
    stream.write('after-error');

    expect(child[`${streamName}Tail`]).toBe('before-error');
  });

  it('bounds invalid UTF-8 public tail output to 64 KiB', () => {
    const rawChild = fakeChildProcess();
    const child = spawnApplicationPluginProcess({
      runner: { executable: '/node', args: ['/runner.js'], runtimeMode: 'node' },
      cwd: '/framework',
      env: {},
      spawn: () => rawChild,
    });

    rawChild.stderr.write(Buffer.alloc(64 * 1024, 0xff));

    expect(Buffer.byteLength(child.stderrTail, 'utf8')).toBeLessThanOrEqual(64 * 1024);
  });

  it('keeps a valid multibyte suffix across split chunks and a truncated prefix', () => {
    const rawChild = fakeChildProcess();
    const child = spawnApplicationPluginProcess({
      runner: { executable: '/node', args: ['/runner.js'], runtimeMode: 'node' },
      cwd: '/framework',
      env: {},
      spawn: () => rawChild,
    });
    const content = Buffer.from(`${'你'.repeat(22_000)}结尾`, 'utf8');
    for (let offset = 0; offset < content.length; offset += 5) {
      rawChild.stdout.write(content.subarray(offset, offset + 5));
    }

    expect(Buffer.byteLength(child.stdoutTail, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(child.stdoutTail.endsWith('结尾')).toBe(true);
    expect(child.stdoutTail).not.toContain('\ufffd');
  });

  it('supports narrow subscriptions, signals, and bounded stdout/stderr tails', () => {
    const rawChild = fakeChildProcess();
    const child = spawnApplicationPluginProcess({
      runner: { executable: '/node', args: ['/runner.js'], runtimeMode: 'node' },
      cwd: '/framework',
      env: {},
      spawn: () => rawChild,
    });
    const messages: unknown[] = [];
    const exits: unknown[] = [];
    const unsubscribeMessage = child.subscribeMessage((message) => messages.push(message));
    const unsubscribeExit = child.subscribeExit((terminal) => exits.push(terminal));

    rawChild.emit('message', { type: 'one' });
    unsubscribeMessage();
    rawChild.emit('message', { type: 'two' });
    rawChild.stdout.write(Buffer.alloc(70 * 1024, 'a'));
    rawChild.stdout.write('stdout-end');
    rawChild.stderr.write(Buffer.alloc(70 * 1024, 'b'));
    rawChild.stderr.write('stderr-end');
    rawChild.emit('exit', 0, null);
    unsubscribeExit();
    rawChild.emit('exit', 1, null);

    expect(messages).toEqual([{ type: 'one' }]);
    expect(exits).toEqual([{
      kind: 'exit', code: 0, signal: null, error: null,
    }]);
    expect(Buffer.byteLength(child.stdoutTail)).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.byteLength(child.stderrTail)).toBeLessThanOrEqual(64 * 1024);
    expect(child.stdoutTail.endsWith('stdout-end')).toBe(true);
    expect(child.stderrTail.endsWith('stderr-end')).toBe(true);
    expect(child.terminate()).toBe(true);
    expect(child.kill()).toBe(true);
    expect(rawChild.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
  });
});
