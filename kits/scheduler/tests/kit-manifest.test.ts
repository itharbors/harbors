import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');

describe('Scheduler Kit assembly', () => {
  it('loads the service at application startup and opens the schedule panel', async () => {
    const packageJson = await readJson('package.json');
    const layout = await readJson('layout.json');

    expect(packageJson.name).toBe('@itharbors/kit-scheduler');
    expect(packageJson.version).toBe('0.1.0-preview.1');
    expect(packageJson['ce-editor'].kit.menuRoot).toEqual({
      id: 'scheduler',
      label: 'Scheduler',
    });
    expect(packageJson['ce-editor'].kit.startup.plugins).toEqual([
      '@itharbors/scheduler-service',
    ]);
    expect(packageJson['ce-editor'].kit.plugin).toEqual([
      '@itharbors/scheduler-panel',
    ]);
    expect(layout.windows).toEqual([{
      id: 'scheduler-main',
      type: 'panel-area',
      layout: {
        type: 'leaf',
        panel: '@itharbors/scheduler-panel.scheduler',
        panelType: 'simple',
      },
    }]);
    expect(layout.activePanel).toBe('@itharbors/scheduler-panel.scheduler');
  });

  it('declares matching preview identity and explicit execution permissions', async () => {
    const packageJson = await readJson('package.json');
    const kit = await readJson('kit.json');

    expect(kit).toMatchObject({
      schemaVersion: 1,
      id: packageJson.name,
      version: packageJson.version,
      channel: 'preview',
      publisher: 'itharbors',
      target: { platform: 'any', arch: 'any' },
    });
    expect(kit.permissions).toEqual([
      'application-startup',
      'filesystem',
      'process-execution',
    ]);
  });

  it('keeps the startup plugin free of Session-only contributions', async () => {
    const service = await readJson('plugins/scheduler-service/package.json');
    const panel = await readJson('plugins/scheduler-panel/package.json');

    expect(service['ce-editor'].contribute.panel).toBeUndefined();
    expect(service['ce-editor'].contribute.message.request.scheduler).toEqual([
      'getSnapshot',
      'saveJob',
      'deleteJob',
      'setJobEnabled',
      'runJobNow',
    ]);
    expect(panel['ce-editor'].contribute.panel.scheduler.entry)
      .toBe('./panel.scheduler/dist/index.html');
  });
});

async function readJson(relativePath: string) {
  return JSON.parse(await readFile(path.join(root, relativePath), 'utf8'));
}
