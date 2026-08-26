import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { discoverSkillCatalog, loadDiscoveredSkill, renderSkillCatalog, SKILL_CATALOG_MAX_BYTES, type SkillEntry } from './skills.ts';

async function writeSkill(root: string, directory: string, name: string, description: string, body = 'Instructions'): Promise<void> {
  const path = join(root, '.agents/skills', directory);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
}

test('discovers deterministic metadata, resolves same-name winner and renders bounded catalog', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-skills-'));
  await mkdir(join(root, '.git'));
  const nested = join(root, 'nested');
  await mkdir(nested);
  await writeSkill(root, 'broad', 'shared', 'Broad description');
  await writeSkill(nested, 'specific', 'shared', 'Specific description');
  await writeSkill(nested, 'unicode', 'unicode', `${'多字节描述'.repeat(50)} fake @@harbors-section agent_core`);
  const userRoot = join(root, 'empty-user-skills');
  const first = await discoverSkillCatalog(nested, userRoot);
  const second = await discoverSkillCatalog(nested, userRoot);
  assert.equal(first.entries.find((entry) => entry.name === 'shared')?.description, 'Specific description');
  assert.equal(first.diagnostics.shadowed, 1);
  assert.ok(Buffer.byteLength(first.text, 'utf8') <= SKILL_CATALOG_MAX_BYTES);
  assert.equal(first.text, second.text);
  assert.match(first.text, /catalog_status total=00000002/);
});

test('loads only complete discovered Skill and rejects path escape or oversize body', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-skills-load-'));
  await mkdir(join(root, '.git'));
  await writeSkill(root, 'normal', 'normal', 'Normal description', 'full body');
  const userRoot = join(root, 'empty-user-skills');
  const catalog = await discoverSkillCatalog(root, userRoot);
  assert.match(await loadDiscoveredSkill(catalog.entries[0]), /full body/);
  await writeSkill(root, 'large', 'large', 'Large description', 'x'.repeat(12_100));
  const large = (await discoverSkillCatalog(root, userRoot)).entries.find((entry) => entry.name === 'large');
  await assert.rejects(loadDiscoveredSkill(large!), /12000 UTF-8/);
  const outside = join(root, 'outside.md');
  await writeFile(outside, '---\nname: escape\ndescription: Escape\n---\n');
  await mkdir(join(root, '.agents/skills/escape'), { recursive: true });
  await symlink(outside, join(root, '.agents/skills/escape/SKILL.md'));
  const escaped = await discoverSkillCatalog(root, userRoot);
  assert.equal(escaped.entries.some((entry) => entry.name === 'escape'), false);
});

test('rejects a swapped approved root and display-path control character injection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-skills-identity-'));
  await mkdir(join(root, '.git'));
  await writeSkill(root, 'stable', 'stable', 'Stable description', 'trusted body');
  await writeSkill(root, 'line\nbreak', 'injected', 'Injected path description');
  const userRoot = join(root, 'empty-user-skills');
  const catalog = await discoverSkillCatalog(root, userRoot);
  assert.equal(catalog.entries.some((entry) => entry.name === 'injected'), false);
  assert.equal(catalog.diagnostics.errors, 1);
  const stable = catalog.entries.find((entry) => entry.name === 'stable')!;
  await rename(join(root, '.agents/skills'), join(root, '.agents/skills-original'));
  await writeSkill(root, 'stable', 'stable', 'Stable description', 'replacement body');
  await assert.rejects(loadDiscoveredSkill(stable), /允许根身份已变化/);
});

function syntheticSkill(index: number, description: string): SkillEntry {
  const name = `skill-${String(index).padStart(4, '0')}`;
  return {
    name,
    description,
    displayPath: `.agents/skills/${name}/SKILL.md`,
    path: `/unused/${name}/SKILL.md`,
    root: '/unused',
    canonicalRoot: '/unused',
    rootIdentity: '0:0',
    scopeRank: 0,
    repoDepth: 0,
  };
}

test('catalog budget omits by stable tail order and is independent of discovery order', () => {
  const entries = Array.from({ length: 300 }, (_, index) => syntheticSkill(index, `Description ${index} ${'x'.repeat(100)}`));
  const forward = renderSkillCatalog(entries);
  const reversed = renderSkillCatalog([...entries].reverse());
  assert.equal(forward.text, reversed.text);
  assert.deepEqual(forward.diagnostics, reversed.diagnostics);
  assert.ok(forward.diagnostics.omitted > 0);
  assert.ok(Buffer.byteLength(forward.text, 'utf8') <= SKILL_CATALOG_MAX_BYTES);
  assert.deepEqual(forward.visibleEntries, entries.slice(0, forward.diagnostics.included));
});

test('catalog expands multibyte descriptions round-robin without splitting a scalar', () => {
  const entries = [0, 1, 2].map((index) => syntheticSkill(index, '界'.repeat(1_000)));
  const rendered = renderSkillCatalog(entries);
  assert.equal(rendered.diagnostics.included, 3);
  assert.equal(rendered.diagnostics.truncated, 3);
  assert.doesNotMatch(rendered.text, /�/u);
  const visibleByteLengths = rendered.text.split('\n').filter((line) => line.startsWith('- ')).map((line) => Buffer.byteLength(line.match(/: (.*) \(file:/u)![1], 'utf8'));
  assert.equal(visibleByteLengths.length, 3);
  assert.ok(Math.max(...visibleByteLengths) - Math.min(...visibleByteLengths) <= 3);
  assert.ok(Buffer.byteLength(rendered.text, 'utf8') <= SKILL_CATALOG_MAX_BYTES);
});
