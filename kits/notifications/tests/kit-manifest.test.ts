import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

  it('runs Notification Kit tests from the repository test gate', () => {
    const rootPackage = readJson(path.join(projectRoot, 'package.json'));
    expect(rootPackage.scripts.test).toContain(
      'npm run test -w @itharbors/kit-notifications',
    );
  });
});

function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
