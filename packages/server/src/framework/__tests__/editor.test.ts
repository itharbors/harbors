import { afterEach, describe, expect, it } from 'vitest';
import { createEditor } from '../../editor';
import { createDefaultAssemblyConfig } from '../../assembly/config';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

describe('panel plugin contributions', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('preserves multiInstance from plugin panel contributions', async () => {
    const pluginRoot = await mkdtemp(path.join(os.tmpdir(), 'ce-panel-plugin-'));
    tempDirs.push(pluginRoot);

    const pluginDir = path.join(pluginRoot, 'panel-plugin');
    await mkdir(path.join(pluginDir, 'main', 'dist'), { recursive: true });
    await mkdir(path.join(pluginDir, 'panel', 'dist'), { recursive: true });
    await writeFile(path.join(pluginDir, 'package.json'), JSON.stringify({
      name: 'panel-plugin',
      type: 'module',
      main: './main/dist/index.js',
      'ce-editor': {
        contribute: {
          panel: {
            inspector: {
              entry: './panel/dist/index.html',
              title: 'Inspector',
              multiInstance: true,
            },
          },
        },
      },
    }, null, 2));
    await writeFile(path.join(pluginDir, 'main', 'dist', 'index.js'), "editor.plugin.define({});\n");
    await writeFile(path.join(pluginDir, 'panel', 'dist', 'index.html'), '<html></html>\n');

    const editor = createEditor('test-session', {
      assembly: createDefaultAssemblyConfig(projectRoot, {
        pluginsDir: pluginRoot,
      }),
    });

    await editor.plugin.register(pluginDir);
    await editor.plugin.load(pluginDir);

    expect(editor.panel.getInfo('panel-plugin.inspector')).toMatchObject({
      name: 'panel-plugin.inspector',
      multiInstance: true,
    });
  });

  it('opens a secondary window-group for a multi-instance panel', async () => {
    const editor = createEditor('test-session', {
      assembly: createDefaultAssemblyConfig(projectRoot),
    });

    await editor.kit.load('@itharbors/kit-default');

    const opened = editor.window.openPanel('@ce/log.log');

    expect(opened).toMatchObject({
      disposition: 'open-window-group',
      panelName: '@ce/log.log',
      carrier: 'window-group',
    });
    expect(editor.window.getSnapshot().windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'secondary' }),
      ]),
    );
  });
});
