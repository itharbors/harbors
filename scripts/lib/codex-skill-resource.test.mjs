import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  prepareCodexSkillResource,
  resolveCodexSkillSource,
} from './codex-skill-resource.mjs';

const scriptsDir = fileURLToPath(new URL('..', import.meta.url));
const electronSource = fs.readFileSync(path.join(scriptsDir, 'electron.mjs'), 'utf8');

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

test('runs the resource copy after every plugin build', () => {
  const rootPackage = JSON.parse(fs.readFileSync(path.join(scriptsDir, '..', 'package.json'), 'utf8'));
  assert.match(rootPackage.scripts['plugins:build'], /prepare-notification-skill-resource\.mjs/);
});
