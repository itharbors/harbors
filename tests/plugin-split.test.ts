import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const kitRoot = path.resolve(__dirname, '..');

describe('notification plugin scopes', () => {
  it('declares the background plugin at startup and the center plugin lazily', () => {
    const manifest = readJson(path.join(kitRoot, 'package.json'));

    expect(manifest['ce-editor'].kit.startup.plugins).toEqual([
      '@itharbors/notification-background',
    ]);
    expect(manifest['ce-editor'].kit.plugin).toEqual([
      '@itharbors/notification-center',
    ]);
  });

  it('keeps installer contributions in the panel-free background package', () => {
    const background = readJson(path.join(
      kitRoot,
      'plugins',
      'notification-background',
      'package.json',
    ));
    const center = readJson(path.join(
      kitRoot,
      'plugins',
      'notification-center',
      'package.json',
    ));

    expect(background.name).toBe('@itharbors/notification-background');
    expect(background['ce-editor'].contribute.panel).toBeUndefined();
    expect(background['ce-editor'].contribute.message.request).toEqual({
      installCodexSkill: ['installCodexSkill'],
    });
    expect(background['ce-editor'].contribute.menu).toEqual([
      expect.objectContaining({
        id: 'install-codex-notification-skill',
        message: 'installCodexSkill',
      }),
    ]);

    expect(center['ce-editor'].contribute.message.request.installCodexSkill).toBeUndefined();
    expect(JSON.stringify(center['ce-editor'].contribute.menu)).not.toContain('installCodexSkill');
    expect(center['ce-editor'].contribute.panel.center).toBeDefined();
  });
});

function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
