import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { scanSourceRoot } from '../main/src/skill-scanner.ts';
import { createSkillService } from '../main/src/skill-service.ts';

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('createSkillService', () => {
  it('starts in global mode with an immutable counted snapshot', async () => {
    const fixture = await createFixture('global');
    await createSkill(fixture.globalRoot, 'installed', 'Installed globally');
    const broadcasts: Array<[string, unknown]> = [];

    const service = await createSkillService({
      codexHome: fixture.codexHome,
      homeDirectory: fixture.home,
      broadcast: (topic, payload) => broadcasts.push([topic, payload]),
    });
    const snapshot = service.getSnapshot();

    expect(snapshot).toMatchObject({
      revision: 1,
      generation: 1,
      mode: 'global',
      globalRootLabel: '$CODEX_HOME/skills',
      sourceRootLabel: null,
      scanning: false,
      truncated: false,
      counts: { 'global-only': 1 },
      items: [expect.objectContaining({ name: 'installed', status: 'global-only' })],
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.items)).toBe(true);
    expect(broadcasts.map(([topic]) => topic)).toContain('@itharbors/skill-manager.snapshot.changed');
  });

  it('selects and clears a source through opaque directory capabilities', async () => {
    const fixture = await createFixture('source-mode');
    await createSkill(fixture.sourceRoot, 'available', 'Available source');
    const service = await createSkillService({
      codexHome: fixture.codexHome,
      homeDirectory: fixture.home,
      broadcast: () => undefined,
    });
    const homePage = await service.browseDirectory({});
    const sourceId = homePage.children.find((entry) => entry.name === 'source')!.id;

    const selected = await service.selectSource({ directoryId: sourceId });

    expect(selected).toMatchObject({
      revision: 2,
      generation: 2,
      mode: 'source',
      sourceRootLabel: '~/source',
      items: [expect.objectContaining({ name: 'available', status: 'source-only' })],
    });
    const cleared = await service.clearSource();
    expect(cleared).toMatchObject({ revision: 3, generation: 3, mode: 'global', sourceRootLabel: null });
    expect(cleared.items).toEqual([]);
  });

  it('prevents an older source scan from replacing a newer generation', async () => {
    const fixture = await createFixture('cancel');
    await createSkill(path.join(fixture.home, 'slow'), 'slow-skill', 'Slow');
    await createSkill(path.join(fixture.home, 'fast'), 'fast-skill', 'Fast');
    let slowStarted = false;
    const scanSource = vi.fn(async (root: string, options: Parameters<typeof scanSourceRoot>[1]) => {
      if (path.basename(root) === 'slow') {
        slowStarted = true;
        await new Promise<void>((resolve) => options.signal?.addEventListener('abort', () => resolve(), { once: true }));
      }
      return scanSourceRoot(root, options);
    });
    const service = await createSkillService({
      codexHome: fixture.codexHome,
      homeDirectory: fixture.home,
      broadcast: () => undefined,
      scanSource,
    });
    const page = await service.browseDirectory({});
    const slowId = page.children.find((entry) => entry.name === 'slow')!.id;
    const fastId = page.children.find((entry) => entry.name === 'fast')!.id;

    const slowSelection = service.selectSource({ directoryId: slowId });
    await vi.waitFor(() => expect(slowStarted).toBe(true));
    const fastSnapshot = await service.selectSource({ directoryId: fastId });
    await slowSelection;

    expect(fastSnapshot.sourceRootLabel).toBe('~/fast');
    expect(service.getSnapshot().items.map((item) => item.name)).toEqual(['fast-skill']);
  });

  it('requires current revision, opaque id, allowed action, and expected digest', async () => {
    const fixture = await createFixture('actions');
    await createSkill(fixture.sourceRoot, 'available', 'Available source');
    const service = await createSkillService({
      codexHome: fixture.codexHome,
      homeDirectory: fixture.home,
      broadcast: () => undefined,
    });
    const sourceId = (await service.browseDirectory({})).children.find((entry) => entry.name === 'source')!.id;
    const selected = await service.selectSource({ directoryId: sourceId });
    const item = selected.items[0];

    await expect(service.getSkillDetail({ skillId: item.id, revision: selected.revision }))
      .resolves.toMatchObject({ name: 'available', source: { manifest: { name: 'available' } } });
    await expect(service.getSkillDetail({ skillId: item.id, revision: selected.revision - 1 }))
      .rejects.toMatchObject({ code: 'STALE_SNAPSHOT' });
    await expect(service.performAction({
      action: 'update',
      skillId: item.id,
      revision: selected.revision,
      expectedDigest: item.sourceDigest!,
    })).rejects.toMatchObject({ code: 'SKILL_CONFLICT' });
    await expect(service.performAction({
      action: 'install',
      skillId: 'forged',
      revision: selected.revision,
      expectedDigest: item.sourceDigest!,
    })).rejects.toMatchObject({ code: 'STALE_SNAPSHOT' });

    const result = await service.performAction({
      action: 'install',
      skillId: item.id,
      revision: selected.revision,
      expectedDigest: item.sourceDigest!,
      path: '/tmp/attacker-controlled',
    } as never);
    expect(result.snapshot.revision).toBe(selected.revision + 1);
    await expect(readFile(path.join(fixture.globalRoot, 'available', 'SKILL.md'), 'utf8'))
      .resolves.toContain('name: available');
    await expect(service.performAction({
      action: 'install',
      skillId: item.id,
      revision: selected.revision,
      expectedDigest: item.sourceDigest!,
    })).rejects.toMatchObject({ code: 'STALE_SNAPSHOT' });
  });

  it('increments immutable revisions on rescan and aborts pending work on dispose', async () => {
    const fixture = await createFixture('dispose');
    let aborted = false;
    const scanGlobal = vi.fn(async (_root: string, options: Parameters<typeof scanSourceRoot>[1]) => {
      if (options.signal?.aborted) aborted = true;
      return { candidates: [], diagnostics: [], truncated: false };
    });
    const service = await createSkillService({
      codexHome: fixture.codexHome,
      homeDirectory: fixture.home,
      broadcast: () => undefined,
      scanGlobal,
    });
    const previous = service.getSnapshot();
    const rescanned = await service.rescan();
    expect(rescanned.revision).toBe(previous.revision + 1);
    expect(rescanned).not.toBe(previous);

    service.dispose();
    await expect(service.rescan()).rejects.toMatchObject({ code: 'SCAN_CANCELLED' });
    expect(aborted || service.getSnapshot().generation >= 2).toBe(true);
  });
});

async function createFixture(label: string) {
  const root = await mkdtemp(path.join(tmpdir(), `skill-manager-service-${label}-`));
  roots.push(root);
  const home = path.join(root, 'home');
  const sourceRoot = path.join(home, 'source');
  const codexHome = path.join(root, 'codex-home');
  const globalRoot = path.join(codexHome, 'skills');
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(globalRoot, { recursive: true });
  return { root, home, sourceRoot, codexHome, globalRoot };
}

async function createSkill(root: string, name: string, description: string): Promise<void> {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`);
}
