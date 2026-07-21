import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  parseNotifyArgs,
  sendNotification,
} from '../scripts/notify.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(testDir, '../scripts/notify.mjs');
const skillDir = path.resolve(testDir, '..');
const repositoryRoot = path.resolve(skillDir, '../../..');

test('Skill instructions are independent of the current project directory', async () => {
  const instructions = await readFile(path.join(skillDir, 'SKILL.md'), 'utf8');

  assert.doesNotMatch(instructions, /Run from the repository root/i);
  assert.match(instructions, /directory containing (?:the loaded |this )?`SKILL\.md`/i);
  assert.match(instructions, /absolute path/i);
});

test('README documents user-level installation from the bundled Skill source', async () => {
  const readme = await readFile(path.join(repositoryRoot, 'readme.md'), 'utf8');

  assert.match(readme, /https:\/\/github\.com\/itharbors\/harbors\/tree\/main\/\.agents\/skills\/notify-user/);
  assert.match(readme, /~\/\.codex\/skills\/notify-user/);
  assert.match(readme, /安装为用户级 Codex Skill/);
});

test('parses a transient notification with safe defaults', () => {
  assert.deepEqual(parseNotifyArgs([
    '--title',
    'Task done',
    '--body',
    'Tests passed',
  ]), {
    title: 'Task done',
    body: 'Tests passed',
    source: 'Codex',
  });
});

test('parses all supported notification options', () => {
  assert.deepEqual(parseNotifyArgs([
    '--title', 'Database migration',
    '--body', 'Approval is required',
    '--level', 'warning',
    '--source', 'Release Agent',
    '--duration', '12000',
    '--persistent',
  ]), {
    title: 'Database migration',
    body: 'Approval is required',
    level: 'warning',
    source: 'Release Agent',
    durationMs: 12000,
    persistent: true,
  });
});

test('rejects missing values, unknown flags and invalid options', () => {
  const cases = [
    [[], /--title is required/],
    [['--title'], /--title requires a value/],
    [['--title', 'x', '--unknown'], /Unknown option: --unknown/],
    [['--title', 'x', '--level', 'debug'], /--level must be one of/],
    [['--title', 'x', '--duration', '999'], /--duration must be between 1000 and 60000/],
    [['--title', 'x', 'loose'], /Unexpected argument: loose/],
  ];

  for (const [args, expected] of cases) {
    assert.throws(() => parseNotifyArgs(args), expected);
  }
});

test('posts JSON to the configured loopback Host', async () => {
  const calls = [];
  const notification = { id: 'created-1', title: 'Done' };
  const result = await sendNotification({ title: 'Done', source: 'Codex' }, {
    port: 18001,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(notification), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.deepEqual(result, notification);
  assert.equal(calls[0].url, 'http://127.0.0.1:18001/v1/notifications');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].options.body), { title: 'Done', source: 'Codex' });
});

test('surfaces structured Host errors and connection failures', async () => {
  await assert.rejects(
    sendNotification({ title: 'Invalid' }, {
      fetchImpl: async () => new Response(JSON.stringify({
        error: { code: 'INVALID_NOTIFICATION', message: 'title is too long' },
      }), { status: 400 }),
    }),
    /title is too long/,
  );

  await assert.rejects(
    sendNotification({ title: 'Offline' }, {
      fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); },
    }),
    /Desktop notification service is unavailable.*ECONNREFUSED/,
  );
});

test('rejects successful Host responses without a notification id', async () => {
  await assert.rejects(
    sendNotification({ title: 'Missing id' }, {
      fetchImpl: async () => new Response('{}', {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    }),
    /success response without a notification id/,
  );
});

test('validates the configured Host port before sending', async () => {
  await assert.rejects(
    sendNotification({ title: 'Bad port' }, { port: 'not-a-port', fetchImpl: async () => null }),
    /port must be an integer between 1 and 65535/,
  );
});

test('CLI prints the created id and exits zero on success', async (t) => {
  const server = http.createServer(async (request, response) => {
    assert.equal(request.url, '/v1/notifications');
    const body = await readBody(request);
    assert.equal(JSON.parse(body).title, 'CLI complete');
    response.statusCode = 201;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ id: 'cli-1', title: 'CLI complete' }));
  });
  const port = await listen(server);
  t.after(() => close(server));

  const result = await runCli(['--title', 'CLI complete'], {
    HARBORS_NOTIFICATION_PORT: String(port),
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Notification sent: cli-1/);
  assert.equal(result.stderr, '');
});

test('installed Skill CLI runs from an unrelated working directory', async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'notify-user-skill-'));
  const installedSkillDir = path.join(tempRoot, 'user-skills', 'notify-user');
  const unrelatedCwd = path.join(tempRoot, 'other-project');
  await cp(skillDir, installedSkillDir, { recursive: true });
  await mkdir(unrelatedCwd, { recursive: true });
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const server = http.createServer((_request, response) => {
    response.statusCode = 201;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ id: 'installed-1', title: 'Installed Skill' }));
  });
  const port = await listen(server);
  t.after(() => close(server));

  const result = await runCli(['--title', 'Installed Skill'], {
    HARBORS_NOTIFICATION_PORT: String(port),
  }, {
    cwd: unrelatedCwd,
    cliPath: path.join(installedSkillDir, 'scripts', 'notify.mjs'),
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Notification sent: installed-1/);
  assert.equal(result.stderr, '');
});

test('CLI exits non-zero and writes an actionable Host error', async (t) => {
  const server = http.createServer((_request, response) => {
    response.statusCode = 503;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Host is shutting down' } }));
  });
  const port = await listen(server);
  t.after(() => close(server));

  const result = await runCli(['--title', 'Will fail'], {
    HARBORS_NOTIFICATION_PORT: String(port),
  });

  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Notification failed: Host is shutting down/);
});

function runCli(args, env, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [options.cliPath ?? scriptPath, ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(address.port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
