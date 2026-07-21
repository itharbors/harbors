import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveCodexSkillSource } from './codex-skill-resource.mjs';

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
  }), path.resolve('/Applications/Harbors.app/Contents/Resources/skills/notify-user'));
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
