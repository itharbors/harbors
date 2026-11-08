import { describe, expect, it } from 'vitest';
import { createEditor } from '../../src/editor/index';
import { createKitFixture } from '../../src/framework/__tests__/kit-fixture';
import { testAssembly } from '../helpers/assembly';
import { createTestPluginPathRoots } from '../helpers/plugin-paths';

describe('local menu panel presentation', () => {
  it('keeps desktop window state intact and rejects invalid, unavailable and cross-owner panels', async () => {
    const fixture = createKitFixture({ name: 'local-menu-fixture', mainPanel: 'alpha.viewer', plugins: [
      {
        name: 'alpha',
        contribute: {
          panel: { viewer: { entry: './panel.viewer/dist/index.html' } },
          menu: [
            { type: 'menu', id: 'view', label: 'View' },
            { type: 'menu', id: 'view/own', message: 'open', localMessage: 'local' },
            { type: 'menu', id: 'view/foreign', message: 'open', localMessage: 'foreign' },
            { type: 'menu', id: 'view/missing', message: 'open', localMessage: 'missing' },
            { type: 'menu', id: 'view/malformed', message: 'open', localMessage: 'malformed' },
            { type: 'menu', id: 'view/throws', message: 'open', localMessage: 'throws' },
            { type: 'menu', id: 'view/legacy', message: 'open' },
          ],
          message: { request: { open: ['open'], local: ['local'], foreign: ['foreign'], missing: ['missing'], malformed: ['malformed'], throws: ['throws'] } },
        },
        code: `let runtime; editor.plugin.define({ lifecycle: { load(v) { runtime = v; } }, methods: {
          open() { return runtime.window.openPanel('alpha.viewer'); },
          local() { return { type: 'local-panel', panelName: 'alpha.viewer', ignored: 'not exposed' }; },
          foreign() { return { type: 'local-panel', panelName: 'beta.viewer' }; },
          missing() { return { type: 'local-panel', panelName: 'alpha.absent' }; },
          malformed() { return { type: 'wrong', panelName: 'alpha.viewer' }; },
          throws() { throw new Error('fixture failure'); },
        } });`,
      },
      { name: 'beta', contribute: { panel: { viewer: { entry: './panel.viewer/dist/index.html' } } } },
    ] });
    const editor = createEditor('local-menu-session', {
      assembly: { ...testAssembly, kitSources: [...testAssembly.kitSources, { directory: fixture.directory, source: 'explicit' }] },
      identity: { userId: 'local-menu-user', sessionId: 'local-menu-session' },
      pluginPathRoots: createTestPluginPathRoots(),
    });
    try {
      await editor.kit.load(fixture.directory);
      const before = editor.window.getSnapshot();
      const local = await Promise.all(Array.from({ length: 8 }, () => editor.menu.trigger('view/own', 'local')));
      expect(local).toEqual(Array.from({ length: 8 }, () => ({ type: 'local-panel', panelName: 'alpha.viewer' })));
      expect(editor.window.getSnapshot()).toEqual(before);

      const desktop = await editor.menu.trigger('view/own');
      expect(desktop).toMatchObject({ disposition: 'open-window-group', panelName: 'alpha.viewer' });
      const desktopState = editor.window.getSnapshot();
      expect(desktopState.panelInstances).toHaveLength(1);
      await expect(editor.menu.trigger('view/own', 'local')).resolves.toEqual({ type: 'local-panel', panelName: 'alpha.viewer' });
      expect(editor.window.getSnapshot()).toEqual(desktopState);
      await expect(editor.menu.trigger('view/legacy', 'local')).resolves.toMatchObject({ disposition: 'reuse', panelName: 'alpha.viewer' });
      expect(editor.window.getSnapshot()).toEqual(desktopState);

      await expect(editor.menu.trigger('view/foreign', 'local')).rejects.toThrow('not owned');
      await expect(editor.menu.trigger('view/missing', 'local')).rejects.toThrow('unavailable');
      await expect(editor.menu.trigger('view/malformed', 'local')).rejects.toThrow('Invalid local panel result');
      await expect(editor.menu.trigger('view/throws', 'local')).rejects.toThrow('fixture failure');
      expect(editor.window.getSnapshot()).toEqual(desktopState);
      editor.panel.unregister('alpha.viewer');
      await expect(editor.menu.trigger('view/own', 'local')).rejects.toThrow('unavailable');
      expect(editor.window.getSnapshot()).toEqual(desktopState);
    } finally {
      await editor.dispose();
      await fixture.dispose();
    }
  });
});
