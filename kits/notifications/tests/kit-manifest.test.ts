import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { buildKit } from '@itharbors/kit-cli';
import { describe, expect, it } from 'vitest';

const kitRoot = fileURLToPath(new URL('..', import.meta.url));
const projectRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('Notification Kit manifest', () => {
  it('declares one notification-center panel as its complete workspace', () => {
    const pkg = readJson(path.join(kitRoot, 'package.json'));
    const layout = readJson(path.join(kitRoot, 'layout.json'));
    const plugin = readJson(path.join(
      kitRoot,
      'plugins/notification-center/package.json',
    ));
    const mainEntry = fs.readFileSync(path.join(kitRoot, 'main.html'), 'utf8');
    const secondaryEntry = fs.readFileSync(path.join(kitRoot, 'secondary.html'), 'utf8');

    expect(pkg.name).toBe('@itharbors/kit-notifications');
    expect(pkg['ce-editor'].kit.menuRoot).toEqual({
      id: 'notifications',
      label: 'Notifications',
    });
    expect(pkg['ce-editor'].kit.plugin).toEqual([
      '@itharbors/notification-center',
    ]);
    expect(pkg['ce-editor'].kit.startup.plugins).toEqual([
      '@itharbors/notification-background',
    ]);
    expect(pkg['ce-editor'].kit.layouts).toEqual({ default: 'layout.json' });
    expect(pkg['ce-editor'].kit.windowEntries).toEqual({
      main: 'main.html',
      secondary: 'secondary.html',
    });

    expect(layout.windows).toEqual([{
      id: 'notifications-main',
      type: 'panel-area',
      layout: {
        type: 'leaf',
        panel: '@itharbors/notification-center.center',
        panelType: 'simple',
      },
    }]);
    expect(layout.activePanel).toBe('@itharbors/notification-center.center');

    expect(plugin.name).toBe('@itharbors/notification-center');
    expect(plugin.main).toBe('./main/dist/index.js');
    expect(plugin['ce-editor'].contribute.panel.center).toMatchObject({
      entry: './panel.center/dist/index.html',
      title: 'Notifications',
      multiInstance: false,
    });
    expect(plugin['ce-editor'].contribute.message.request).toEqual({
      getSnapshot: ['getSnapshot'],
      markRead: ['markRead'],
      markAllRead: ['markAllRead'],
      removeNotification: ['removeNotification'],
      openCenterPanel: ['openCenterPanel'],
    });
    expect(JSON.stringify(plugin['ce-editor'].contribute.menu)).not.toContain('installCodexSkill');
    expect(mainEntry).toContain('<title>Notifications</title>');
    expect(secondaryEntry).toContain('<title>Notification Window</title>');
  });

  it('builds the Skill artifact from an isolated copy of only this Kit', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'notifications-isolated-'));
    const isolatedKit = path.join(temporary, 'kit');
    try {
      const sourceTestResource = path.join(kitRoot, 'plugins/notification-background/main/src/resources');
      await cp(kitRoot, isolatedKit, { recursive: true, filter: (source) => (
        source !== sourceTestResource
        && !source.startsWith(`${sourceTestResource}${path.sep}`)
        && !source.split(path.sep).some((component) => ['.build', 'dist', 'node_modules'].includes(component))
      ) });
      await cp(path.join(projectRoot, 'node_modules/@types/node'), path.join(isolatedKit, 'node_modules/@types/node'), { recursive: true });
      await cp(path.join(projectRoot, 'node_modules/undici-types'), path.join(isolatedKit, 'node_modules/undici-types'), { recursive: true });
      await buildKit({ directory: isolatedKit });
      expect(await readFile(path.join(isolatedKit, 'plugins/notification-background/main/dist/resources/notify-user/SKILL.md'), 'utf8'))
        .toBe(await readFile(path.join(isolatedKit, 'resources/notify-user/SKILL.md'), 'utf8'));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }, 30_000);

});

function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
