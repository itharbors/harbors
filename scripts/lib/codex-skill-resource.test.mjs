import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  prepareCodexSkillResource,
  resolveCodexSkillSource,
} from './codex-skill-resource.mjs';
import { createBuildPlan } from './build-tasks.mjs';

const scriptsDir = fileURLToPath(new URL('..', import.meta.url));
const electronSource = fs.readFileSync(path.join(scriptsDir, 'electron.mjs'), 'utf8');
const execFileAsync = promisify(execFile);

test('resolves the repository Skill in development and application resources when packaged', () => {
  assert.equal(resolveCodexSkillSource({
    isPackaged: false,
    resourcesPath: '/Applications/Harbors.app/Contents/Resources',
    rootDir: '/workspace/harbors',
  }), path.resolve('/workspace/harbors/.agents/skills/notify-user'));

  assert.equal(resolveCodexSkillSource({
    isPackaged: true,
    resourcesPath: '/Applications/Harbors.app/Contents/Resources',
    rootDir: '/workspace/harbors',
  }), path.resolve(
    '/Applications/Harbors.app/Contents/Resources/runtime/resources/notify-user',
  ));
});

test('rejects relative or missing Electron resource roots', () => {
  assert.throws(() => resolveCodexSkillSource({
    isPackaged: false,
    resourcesPath: '/resources',
    rootDir: 'relative/root',
  }), /rootDir must be an absolute path/);
  assert.throws(() => resolveCodexSkillSource({
    isPackaged: true,
    resourcesPath: '',
    rootDir: '/workspace/harbors',
  }), /resourcesPath must be an absolute path/);
});

test('passes the resolved bundled Skill path only to the Electron Framework child', () => {
  assert.match(electronSource, /resolveCodexSkillSource\(\{/);
  assert.match(electronSource, /HARBORS_NOTIFY_SKILL_SOURCE: codexSkillSource/);
});

test('copies the canonical Skill into the packaged plugin resources', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-skill-resource-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'source', 'notify-user');
  const destinationDir = path.join(root, 'main', 'dist', 'resources', 'notify-user');
  await mkdir(path.join(sourceDir, 'scripts'), { recursive: true });
  await writeFile(path.join(sourceDir, 'SKILL.md'), 'name: notify-user\n');
  await writeFile(path.join(sourceDir, 'scripts', 'notify.mjs'), '// bundled\n');

  await prepareCodexSkillResource({ sourceDir, destinationDir });

  await assert.doesNotReject(readFile(path.join(destinationDir, 'SKILL.md'), 'utf8'));
  assert.equal(await readFile(path.join(destinationDir, 'scripts', 'notify.mjs'), 'utf8'), '// bundled\n');
});

test('lets the owning Kit lifecycle produce the notification Skill resource', async () => {
  const tasks = (await createBuildPlan(path.join(scriptsDir, '..'), 'plugins')).tasks;
  const resource = 'kits/notifications/plugins/notification-background/main/dist/resources/notify-user';
  const owner = tasks.find((task) => task.outputs.some((output) => resource.startsWith(`${output}/`)));

  assert.equal(owner?.kind, 'kit');
  assert.deepEqual(owner.command, {
    file: 'node',
    args: ['packages/kit-cli/dist/cli.js', 'build', owner.kitDir],
  });
  assert.equal(tasks.some((task) => task.kind === 'resource'), false);
  assert.ok(owner.inputs.includes('kits/notifications/scripts/prepare-skill-resource.mjs'));
  assert.ok(owner.inputs.includes('kits/notifications/resources/notify-user/SKILL.md'));
  assert.equal(owner.inputs.some((input) => input.startsWith('.agents/')), false);
});

test('produces the notification Skill resource from a clean direct workspace build', async () => {
  const repositoryRoot = path.join(scriptsDir, '..');
  const resource = path.join(
    repositoryRoot,
    'kits/notifications/plugins/notification-background/main/dist/resources/notify-user',
  );
  await rm(resource, { recursive: true, force: true });

  await execFileAsync('npm', ['run', 'build', '-w', '@itharbors/kit-notifications'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });

  assert.equal(
    await readFile(path.join(resource, 'SKILL.md'), 'utf8'),
    await readFile(path.join(repositoryRoot, 'kits/notifications/resources/notify-user/SKILL.md'), 'utf8'),
  );
});
