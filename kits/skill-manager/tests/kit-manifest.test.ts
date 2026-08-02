import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const kitRoot = fileURLToPath(new URL('..', import.meta.url));
const projectRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('Skill Manager Kit manifest', () => {
  it('declares one filesystem-backed manager panel', () => {
    const pkg = readJson(path.join(kitRoot, 'package.json'));
    const manifest = readJson(path.join(kitRoot, 'kit.json'));
    const layout = readJson(path.join(kitRoot, 'layout.json'));
    const plugin = readJson(path.join(
      kitRoot,
      'plugins/skill-manager/package.json',
    ));
    const mainEntry = fs.readFileSync(path.join(kitRoot, 'main.html'), 'utf8');
    const secondaryEntry = fs.readFileSync(path.join(kitRoot, 'secondary.html'), 'utf8');

    expect(pkg.name).toBe('@itharbors/kit-skill-manager');
    expect(manifest).toMatchObject({
      id: '@itharbors/kit-skill-manager',
      version: '0.1.0-preview.1',
      channel: 'preview',
      permissions: ['filesystem'],
    });
    expect(pkg['ce-editor'].kit.plugin).toEqual(['@itharbors/skill-manager']);
    expect(pkg['ce-editor'].kit.menuRoot).toEqual({
      id: 'skill-manager',
      label: 'Skill 管理器',
    });
    expect(pkg.dependencies).toEqual({ yaml: '2.9.0' });
    expect(pkg['ce-editor'].kit.layouts).toEqual({ default: 'layout.json' });
    expect(pkg['ce-editor'].kit.windowEntries).toEqual({
      main: 'main.html',
      secondary: 'secondary.html',
    });

    expect(layout.windows).toEqual([{
      id: 'skill-manager-main',
      type: 'panel-area',
      layout: {
        type: 'leaf',
        panel: '@itharbors/skill-manager.manager',
        panelType: 'simple',
      },
    }]);
    expect(layout.activePanel).toBe('@itharbors/skill-manager.manager');

    expect(plugin).toMatchObject({
      name: '@itharbors/skill-manager',
      main: './main/dist/index.js',
      dependencies: { yaml: '2.9.0' },
    });
    expect(plugin['ce-editor'].contribute.panel.manager).toMatchObject({
      entry: './panel.manager/dist/index.html',
      title: 'Skill 管理器',
      multiInstance: false,
    });
    expect(plugin['ce-editor'].contribute.message.request).toEqual({
      getSnapshot: ['getSnapshot'],
      browseDirectory: ['browseDirectory'],
      selectSource: ['selectSource'],
      clearSource: ['clearSource'],
      rescan: ['rescan'],
      getSkillDetail: ['getSkillDetail'],
      performAction: ['performAction'],
    });
    expect(plugin['ce-editor'].contribute.message.broadcast).toEqual({
      '@itharbors/skill-manager.snapshot.changed': ['panel.onSnapshotChanged'],
      '@itharbors/skill-manager.scan.progress': ['panel.onScanProgress'],
      '@itharbors/skill-manager.operation.progress': ['panel.onOperationProgress'],
    });
    expect(mainEntry).toContain('<html lang="zh-CN">');
    expect(mainEntry).toContain('<title>Skill 管理器</title>');
    expect(secondaryEntry).toContain('<html lang="zh-CN">');
    expect(secondaryEntry).toContain('<title>Skill 管理器</title>');
  });

});

function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
