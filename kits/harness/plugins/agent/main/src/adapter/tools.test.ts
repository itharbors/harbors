import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { discoverSkillCatalog } from './skills.js';
import { hubbertTools, runHubBertTool } from './tools.js';

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
