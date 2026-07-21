import { describe, it, expect, vi } from 'vitest';
// @ts-expect-error The Electron dev script is an ESM runtime entry without declarations.
import { buildElectronMenuTemplate, buildMultiKitMenuTemplate, configureElectronApp } from '../../../../scripts/electron.mjs';

describe('configureElectronApp', () => {
  it('disables hardware acceleration before Electron becomes ready', () => {
    const disableHardwareAcceleration = vi.fn();

    configureElectronApp({ disableHardwareAcceleration });

    expect(disableHardwareAcceleration).toHaveBeenCalledOnce();
  });
});

describe('buildElectronMenuTemplate', () => {
  it('builds click handlers that carry session and menu id metadata', () => {
    const sendToWindow = vi.fn();
    const template = buildElectronMenuTemplate('session-a', [
      {
        type: 'menu',
        id: 'file',
        label: 'File',
        children: [
          {
            type: 'menu',
            id: 'file/open',
            label: 'Open',
            accelerator: 'CmdOrCtrl+O',
            children: [],
          },
        ],
      },
    ], { sendToWindow });

    expect(template[0]).toMatchObject({ label: 'File' });
    template[0].submenu[0].click();
    expect(sendToWindow).toHaveBeenCalledWith({
      sessionId: 'session-a',
      menuId: 'file/open',
    });
  });

  it('uses menu id click handlers for leaf nodes', () => {
    const sendToWindow = vi.fn();
    const template = buildElectronMenuTemplate('session-a', [
      {
        type: 'menu',
        id: 'help',
        label: 'Help',
        children: [
          {
            type: 'menu',
            id: 'help/about',
            label: 'About',
            children: [],
          },
        ],
      },
    ], { sendToWindow });

    template[0].submenu[0].click();
    expect(sendToWindow).toHaveBeenCalledWith({
      sessionId: 'session-a',
      menuId: 'help/about',
    });
  });

  it('keeps nested panel menu items under the View menu', () => {
    const sendToWindow = vi.fn();
    const template = buildElectronMenuTemplate('session-a', [
      {
        type: 'menu',
        id: 'view',
        label: 'View',
        children: [
          {
            type: 'menu',
            id: 'view/panels',
            label: 'Panels',
            children: [
              {
                type: 'menu',
                id: 'view/panels/ce-log-log',
                label: 'Log',
                children: [],
              },
            ],
          },
        ],
      },
    ], { sendToWindow });

    expect(template[0]).toMatchObject({ label: 'View' });
    expect(template[0].submenu[0]).toMatchObject({ label: 'Panels' });
    expect(template[0].submenu[0].submenu[0]).toMatchObject({ label: 'Log' });

    template[0].submenu[0].submenu[0].click();
    expect(sendToWindow).toHaveBeenCalledWith({
      sessionId: 'session-a',
      menuId: 'view/panels/ce-log-log',
    });
  });

  it('maps builtin desktop roles used by the default menu baseline', () => {
    const template = buildElectronMenuTemplate('session-a', [
      {
        type: 'menu',
        id: 'app',
        label: 'ITHARBORS',
        children: [
          { type: 'menu', id: 'app/about', label: 'About', role: 'about', children: [] },
          { type: 'menu', id: 'app/services', label: 'Services', role: 'services', children: [] },
          { type: 'menu', id: 'app/hide', label: 'Hide', role: 'hide', children: [] },
          { type: 'menu', id: 'app/hide-others', label: 'Hide Others', role: 'hideOthers', children: [] },
          { type: 'menu', id: 'app/show-all', label: 'Show All', role: 'unhide', children: [] },
          { type: 'menu', id: 'app/quit', label: 'Quit', role: 'quit', children: [] },
        ],
      },
      {
        type: 'menu',
        id: 'window',
        label: 'Window',
        children: [
          { type: 'menu', id: 'window/minimize', label: 'Minimize', role: 'minimize', children: [] },
          { type: 'menu', id: 'window/zoom', label: 'Zoom', role: 'zoom', children: [] },
          { type: 'menu', id: 'window/front', label: 'Bring All to Front', role: 'front', children: [] },
          { type: 'menu', id: 'window/close', label: 'Close', role: 'close', children: [] },
        ],
      },
      {
        type: 'menu',
        id: 'view',
        label: 'View',
        children: [
          { type: 'menu', id: 'view/reload', label: 'Reload', role: 'reload', children: [] },
          { type: 'menu', id: 'view/toggle-devtools', label: 'Toggle Developer Tools', role: 'toggleDevTools', children: [] },
          { type: 'menu', id: 'view/reset-zoom', label: 'Actual Size', role: 'resetZoom', children: [] },
          { type: 'menu', id: 'view/zoom-in', label: 'Zoom In', role: 'zoomIn', children: [] },
          { type: 'menu', id: 'view/zoom-out', label: 'Zoom Out', role: 'zoomOut', children: [] },
          { type: 'menu', id: 'view/toggle-fullscreen', label: 'Toggle Full Screen', role: 'togglefullscreen', children: [] },
        ],
      },
      {
        type: 'menu',
        id: 'edit',
        label: 'Edit',
        children: [
          { type: 'menu', id: 'edit/copy', label: 'Copy', role: 'copy', children: [] },
          { type: 'menu', id: 'edit/cut', label: 'Cut', role: 'cut', children: [] },
          { type: 'menu', id: 'edit/paste', label: 'Paste', role: 'paste', children: [] },
          { type: 'menu', id: 'edit/redo', label: 'Redo', role: 'redo', children: [] },
          { type: 'menu', id: 'edit/undo', label: 'Undo', role: 'undo', children: [] },
          { type: 'menu', id: 'edit/select-all', label: 'Select All', role: 'selectAll', children: [] },
          { type: 'menu', id: 'edit/unsafe', label: 'Unsafe', role: 'totallyUnsafe', children: [] },
        ],
      },
    ], { sendToWindow: vi.fn() });

    expect(template[0].submenu.map((item: { role?: string }) => item.role)).toEqual(['about', 'services', 'hide', 'hideOthers', 'unhide', 'quit']);
    expect(template[1].submenu.map((item: { role?: string }) => item.role)).toEqual(['minimize', 'zoom', 'front', 'close']);
    expect(template[2].submenu.map((item: { role?: string }) => item.role)).toEqual(['reload', 'toggleDevTools', 'resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen']);
    expect(template[3].submenu.slice(0, 6).map((item: { role?: string }) => item.role)).toEqual(['copy', 'cut', 'paste', 'redo', 'undo', 'selectAll']);
    expect(template[3].submenu[6].role).toBeUndefined();
  });
});

describe('buildMultiKitMenuTemplate', () => {
  it('aggregates APP and Kit roots while routing each action to its own session', () => {
    const sendToWindow = vi.fn();
    const template = buildMultiKitMenuTemplate({
      focusedSessionId: 'session-a',
      sessions: [
        {
          sessionId: 'session-a',
          applicationMenuTree: [{ type: 'menu', id: 'file', label: 'File', children: [] }],
          kitMenuTree: [{ type: 'menu', id: 'a/action', label: 'Action A', children: [] }],
          kitMenuRoot: { id: 'a', label: 'AKit' },
        },
        {
          sessionId: 'session-b',
          applicationMenuTree: [{ type: 'menu', id: 'file', label: 'File', children: [] }],
          kitMenuTree: [{ type: 'menu', id: 'b/action', label: 'Action B', children: [] }],
          kitMenuRoot: { id: 'b', label: 'BKit' },
        },
      ],
    }, { sendToWindow });

    expect(template.map((item: { label: string }) => item.label)).toEqual(['APP', 'AKit', 'BKit']);
    template[0].submenu[0].click();
    template[1].submenu[0].click();
    template[2].submenu[0].click();
    expect(sendToWindow.mock.calls).toEqual([
      [{ sessionId: 'session-a', menuId: 'file' }],
      [{ sessionId: 'session-a', menuId: 'a/action' }],
      [{ sessionId: 'session-b', menuId: 'b/action' }],
    ]);
  });
});
