import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, symlink, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { discoverSkillCatalog } from './skills.js';
import { hubbertTools, runHubBertTool, type HubBertToolPermissionContext } from './tools.js';

const dangerPermission = {
  conversationId: 'test',
  turn: 1,
  step: 1,
  sandboxMode: 'danger-full-access' as const,
  approvalPolicy: 'ask' as const,
};

const workspacePermission = {
  conversationId: 'test',
  turn: 1,
  step: 1,
  sandboxMode: 'workspace-write' as const,
  approvalPolicy: 'ask' as const,
  requestPermission: async () => 'rejected' as const,
};

test('文件工具拒绝通过目录符号链接触达 workspace 外部', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'harbors-agent-tools-workspace-'));
  const outside = await mkdtemp(join(tmpdir(), 'harbors-agent-tools-outside-'));
  try {
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
    await writeFile(join(workspace, 'inside.txt'), 'inside', 'utf8');
    await symlink(outside, join(workspace, 'escape'), 'dir');

    await assert.rejects(runHubBertTool('read', { file_path: 'escape/secret.txt' }, workspace, undefined, workspacePermission), /拒绝|超出当前工作区|符号链接/);
    await assert.rejects(runHubBertTool('write', { file_path: 'escape/new.txt', content: 'nope' }, workspace, undefined, workspacePermission), /拒绝|超出当前工作区|符号链接/);
    await assert.rejects(runHubBertTool('move', { source: 'inside.txt', destination: 'escape/moved.txt' }, workspace, undefined, workspacePermission), /拒绝|超出当前工作区|符号链接/);
    await assert.rejects(runHubBertTool('delete', { path: 'escape/secret.txt' }, workspace, undefined, workspacePermission), /拒绝|超出当前工作区|符号链接/);
    assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'secret');
    assert.equal(await readFile(join(workspace, 'inside.txt'), 'utf8'), 'inside');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('文件工具允许 workspace 内路径并拒绝规范化后的越界路径', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'harbors-agent-tools-normal-'));
  try {
    await mkdir(join(workspace, 'src'), { recursive: true });
    await runHubBertTool('write', { file_path: 'src/file.txt', content: 'ok' }, workspace);
    assert.match(await runHubBertTool('read', { file_path: 'src/../src/file.txt' }, workspace), /ok/);
    await assert.rejects(runHubBertTool('read', { file_path: '../outside.txt' }, workspace, undefined, workspacePermission), /拒绝|超出当前工作区|符号链接/);
    await assert.rejects(runHubBertTool('read', { file_path: '' }, workspace), /缺少参数/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('模型工具只暴露按需加载并允许直接加载当前 Turn 的 Skill', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'harbors-agent-tools-skill-'));
  try {
    await mkdir(join(workspace, '.agents/skills/direct-load'), { recursive: true });
    await writeFile(join(workspace, '.agents/skills/direct-load/SKILL.md'), '---\nname: direct-load\ndescription: Direct load fixture\n---\nUse this directly.\n', 'utf8');
    const skillCatalog = await discoverSkillCatalog(workspace, join(workspace, '.user-skills'));
    const permission = { ...workspacePermission, skillCatalog };

    assert.equal(hubbertTools.some((tool) => tool.name === 'list_skills'), false);
    assert.equal(hubbertTools.some((tool) => tool.name === 'load_skill'), true);
    assert.match(await runHubBertTool('load_skill', { name: 'direct-load' }, workspace, undefined, permission), /Use this directly\./);
    const missingError = await runHubBertTool('load_skill', { name: 'missing' }, workspace, undefined, permission).then(() => '', String);
    assert.match(missingError, /当前 Turn 的可用 Skill 目录/);
    assert.doesNotMatch(missingError, /list_skills/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('web_fetch 拒绝 IPv4、IPv6、私网和云元数据地址', async () => {
  for (const url of ['http://127.0.0.1/', 'http://[::1]/', 'http://192.168.1.1/', 'http://169.254.169.254/']) {
    await assert.rejects(runHubBertTool('web_fetch', { url }, '/tmp'), /受限网络|本地主机/);
  }
});

test('bash 的非零退出、信号和超时均为失败结果', async () => {
  await assert.rejects(runHubBertTool('bash', { command: 'exit 7' }, process.cwd(), undefined, dangerPermission), /退出码 7/);
  await assert.rejects(runHubBertTool('bash', { command: 'kill -TERM $$' }, process.cwd(), undefined, dangerPermission), /信号 SIGTERM/);
  await assert.rejects(runHubBertTool('bash', { command: 'sleep 2', timeoutMs: 20 }, process.cwd(), undefined, dangerPermission), /超时/);
});

test('bash 取消后不会返回成功结果', async () => {
  const controller = new AbortController();
  const pending = runHubBertTool('bash', { command: 'sleep 2' }, process.cwd(), controller.signal, dangerPermission);
  setTimeout(() => controller.abort(new Error('cancelled')), 20);
  await assert.rejects(pending, /cancelled/);
});

async function waitUntil(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail(message);
}

async function within<T>(promise: Promise<T>, timeoutMs = 3_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('fixture did not settle')), timeoutMs); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

interface BashFixture {
  controller: AbortController;
  child: ChildProcess;
  outcome: Promise<{ value?: string; error?: unknown }>;
  killRequests(): number;
  assertPending(): Promise<void>;
  output(): Promise<void>;
  release(): Promise<void>;
}

async function withBashFixture(run: (fixture: BashFixture) => Promise<void>, options: { timeoutMs?: number; kill?: 'defer' | 'false' | 'throw' } = {}): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'harbors-agent-bash-barrier-'));
  const originalKill = process.kill;
  const originalEmit = ChildProcess.prototype.emit;
  const controller = new AbortController();
  let child: ChildProcess | undefined;
  let closed = false;
  let settled = false;
  let killRequests = 0;
  let outcome: BashFixture['outcome'] | undefined;
  try {
    const script = join(workspace, 'child.cjs');
    const ready = join(workspace, 'ready');
    const outputGate = join(workspace, 'output');
    const exitGate = join(workspace, 'exit');
    await writeFile(script, `
      const fs = require('node:fs');
      const [ready, outputGate, exitGate] = process.argv.slice(2);
      let wroteOutput = false;
      fs.writeFileSync(ready, String(process.pid));
      setInterval(() => {
        if (fs.existsSync(exitGate)) process.exit(0);
        if (!wroteOutput && fs.existsSync(outputGate)) {
          wroteOutput = true;
          process.stdout.write('x'.repeat(200_000));
          process.stderr.write('y'.repeat(200_000));
        }
      }, 10);
    `);
    const command = `exec ${[process.execPath, script, ready, outputGate, exitGate].map(shellQuote).join(' ')}`;
    ChildProcess.prototype.emit = function (event, ...args) {
      if (event === 'spawn' && this.spawnargs.includes(command)) {
        child = this;
        this.once('close', () => { closed = true; });
      }
      return originalEmit.call(this, event, ...args);
    };
    process.kill = ((pid: number, signal?: string | number) => {
      if (child?.pid && pid === -child.pid && signal === 'SIGKILL') {
        killRequests += 1;
        if (options.kill === 'throw') throw new Error('fixture kill denied');
        if (options.kill === 'false') return false;
        return true;
      }
      return originalKill(pid, signal);
    }) as typeof process.kill;
    const skillCatalog = await discoverSkillCatalog(workspace, join(workspace, '.user-skills'));
    outcome = runHubBertTool('bash', { command, timeoutMs: options.timeoutMs || 2_000 }, workspace, controller.signal, { ...dangerPermission, skillCatalog })
      .then((value) => { settled = true; return { value }; }, (error: unknown) => { settled = true; return { error }; });
    await waitUntil(async () => {
      try { return Boolean(child?.pid) && Number(await readFile(ready, 'utf8')) === child?.pid; } catch { return false; }
    }, 'real child must publish its ready/PID marker');
    assert.ok(child?.pid);
    const runningChild = child;
    await run({
      controller,
      child: runningChild,
      outcome,
      killRequests: () => killRequests,
      assertPending: async () => {
        await delay(30);
        assert.equal(closed, false, 'child must still be running before the gate is released');
        assert.equal(originalKill(runningChild.pid!, 0), true);
        assert.equal(settled, false, 'tool must wait for the real child close event');
      },
      output: () => writeFile(outputGate, ''),
      release: () => writeFile(exitGate, ''),
    });
  } finally {
    process.kill = originalKill;
    ChildProcess.prototype.emit = originalEmit;
    controller.abort(new Error('fixture cleanup'));
    try {
      if (child?.pid && !closed) {
        try { originalKill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      if (outcome) await within(outcome);
    }
    finally { await rm(workspace, { recursive: true, force: true }); }
  }
}

const posixFixture = { skip: process.platform === 'win32', timeout: 10_000 };

test('bash abort 后等待真实 close，后续 timeout 和超限输出不能覆盖首因', posixFixture, async () => {
  await withBashFixture(async (fixture) => {
    const reason = new Error('first abort');
    fixture.controller.abort(reason);
    await fixture.output();
    await delay(2_050);
    await fixture.assertPending();
    assert.equal(fixture.killRequests(), 1);
    await fixture.release();
    assert.equal((await within(fixture.outcome)).error, reason);
    assert.equal(fixture.child.stdout?.listenerCount('data'), 0);
    assert.equal(fixture.child.stderr?.listenerCount('data'), 0);
  }, { timeoutMs: 2_000 });
});

test('bash timeout 后等待真实 close，晚到 abort 不覆盖 BASH_TIMEOUT', posixFixture, async () => {
  await withBashFixture(async (fixture) => {
    await waitUntil(() => fixture.killRequests() === 1, 'timeout must request kill');
    fixture.controller.abort(new Error('late abort'));
    await fixture.output();
    await fixture.assertPending();
    await fixture.release();
    assert.equal(((await within(fixture.outcome)).error as { code: string }).code, 'BASH_TIMEOUT');
  }, { timeoutMs: 120 });
});

test('bash output limit 后等待真实 close，晚到 abort 和 timeout 不覆盖首因', posixFixture, async () => {
  await withBashFixture(async (fixture) => {
    await fixture.output();
    await waitUntil(() => fixture.killRequests() === 1, 'output limit must request kill');
    fixture.controller.abort(new Error('late abort'));
    await delay(2_050);
    await fixture.assertPending();
    assert.equal(fixture.killRequests(), 1);
    await fixture.release();
    assert.equal(((await within(fixture.outcome)).error as { code: string }).code, 'BASH_OUTPUT_LIMIT');
  }, { timeoutMs: 2_000 });
});

for (const kill of ['false', 'throw'] as const) {
  test(`bash kill ${kill} 不冒充退出，保留首因并等待真实 close`, posixFixture, async () => {
    await withBashFixture(async (fixture) => {
      const reason = new Error(`abort with kill ${kill}`);
      fixture.controller.abort(reason);
      await fixture.assertPending();
      assert.equal(fixture.killRequests(), 1);
      assert.match(String(reason.cause), kill === 'throw' ? /fixture kill denied/ : /终止请求未送达/);
      await fixture.release();
      assert.equal((await within(fixture.outcome)).error, reason);
    }, { kill });
  });
}

test('bash 成功 spawn 后的 error 等待真实 close，不误报 spawn failure', posixFixture, async () => {
  await withBashFixture(async (fixture) => {
    const childError = new Error('fixture process error');
    fixture.child.emit('error', childError);
    fixture.controller.abort(new Error('late abort'));
    await fixture.assertPending();
    await fixture.release();
    const error = (await within(fixture.outcome)).error as Error & { code: string };
    assert.equal(error.code, 'BASH_PROCESS_ERROR');
    assert.equal(error.cause, childError);
  });
});

test('bash 未 spawn 的异步 error 和同步异常立即返回 BASH_SPAWN_FAILED', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'harbors-agent-bash-spawn-'));
  try {
    const skillCatalog = await discoverSkillCatalog(workspace, join(workspace, '.user-skills'));
    for (const workdir of ['missing-directory', '\0']) {
      await assert.rejects(within(runHubBertTool('bash', { command: 'exit 0', workdir }, workspace, undefined, { ...dangerPermission, skillCatalog })), (error: unknown) => {
        assert.equal((error as { code: string }).code, 'BASH_SPAWN_FAILED');
        return true;
      });
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

const mutationCases = [
  { name: 'write', input: { file_path: 'created.txt', content: 'changed' } },
  { name: 'edit', input: { file_path: 'original.txt', old_string: 'original', new_string: 'changed' } },
  { name: 'move', input: { source: 'original.txt', destination: 'created.txt' } },
  { name: 'delete', input: { path: 'original.txt' } },
  { name: 'bash', input: { command: 'printf changed > created.txt' } },
];

for (const approval of ['allowed-once', 'automatic'] as const) {
  test(`${approval} 允许与 Stop 竞争时所有 mutation 均不启动`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'harbors-agent-tool-abort-'));
    try {
      const skillCatalog = await discoverSkillCatalog(workspace, join(workspace, '.user-skills'));
      for (const mutation of mutationCases) {
        await writeFile(join(workspace, 'original.txt'), 'original');
        const controller = new AbortController();
        const reason = new Error(`cancel before ${mutation.name}`);
        let approvals = 0;
        const permission: HubBertToolPermissionContext = {
          ...dangerPermission,
          skillCatalog,
          get sandboxMode() {
            if (approval === 'automatic') queueMicrotask(() => controller.abort(reason));
            return approval === 'automatic' ? 'danger-full-access' : 'read-only';
          },
          requestPermission: async () => { approvals += 1; controller.abort(reason); return 'allowed-once'; },
        };
        await assert.rejects(runHubBertTool(mutation.name, mutation.input, workspace, controller.signal, permission), (error: unknown) => error === reason);
        assert.equal(approvals, approval === 'automatic' ? 0 : 1);
        assert.equal(await readFile(join(workspace, 'original.txt'), 'utf8'), 'original');
        await assert.rejects(access(join(workspace, 'created.txt')), { code: 'ENOENT' });
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
}

test('sandbox retry 的审批允许返回后先检查取消，不执行越界 mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harbors-agent-tool-retry-'));
  try {
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    await mkdir(workspace);
    await mkdir(outside);
    const skillCatalog = await discoverSkillCatalog(workspace, join(workspace, '.user-skills'));
    const controller = new AbortController();
    const reason = new Error('cancel sandbox retry');
    let approvals = 0;
    await assert.rejects(runHubBertTool('write', { file_path: '../outside/created.txt', content: 'changed' }, workspace, controller.signal, {
      ...workspacePermission,
      skillCatalog,
      requestPermission: async () => { approvals += 1; controller.abort(reason); return 'allowed-once'; },
    }), (error: unknown) => error === reason);
    assert.equal(approvals, 1);
    await assert.rejects(access(join(outside, 'created.txt')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
