import { describe, it, expect, beforeEach } from 'vitest';
import { WindowManager } from '../window/index';

const MAIN_LAYOUT = {
  type: 'leaf',
  panel: '@ce/log.log',
} as const;

describe('WindowManager', () => {
  let wm: WindowManager;

  beforeEach(() => {
    wm = new WindowManager({
      mainWindowId: 'main-window',
      mainEntry: 'main.html',
      secondaryEntry: 'secondary.html',
      mainLayout: MAIN_LAYOUT,
    });
  });

  it('creates the main window-group snapshot at construction time', () => {
    const snapshot = wm.getSnapshot();
    expect(snapshot.windows).toEqual([
      expect.objectContaining({
        id: 'main-window',
        kind: 'main',
        entry: 'main.html',
      }),
    ]);
  });

  it('keeps every default window from kit layout at construction time', () => {
    wm = new WindowManager({
      secondaryEntry: 'secondary.html',
      defaultWindows: [
        {
          id: 'main-window',
          kind: 'main',
          type: 'panel-area',
          entry: 'main.html',
          state: 'open',
          layout: MAIN_LAYOUT,
          panelInstanceIds: [],
        },
        {
          id: 'secondary-tools',
          kind: 'secondary',
          type: 'panel-area',
          entry: 'secondary.html',
          state: 'open',
          layout: { type: 'leaf', panel: '@ce/message-debug.debug' },
          panelInstanceIds: [],
        },
      ],
    });

    expect(wm.getSnapshot().windows).toEqual([
      expect.objectContaining({ id: 'main-window', kind: 'main' }),
      expect.objectContaining({ id: 'secondary-tools', kind: 'secondary' }),
    ]);
  });

  it('reuses a non-multi-instance panel instead of opening a second window-group', () => {
    const first = wm.openPanel({
      panelName: '@ce/log.log',
      layout: { type: 'leaf', panel: '@ce/log.log' },
      entry: 'secondary.html',
      multiInstance: false,
    });
    const second = wm.openPanel({
      panelName: '@ce/log.log',
      layout: { type: 'leaf', panel: '@ce/log.log' },
      entry: 'secondary.html',
      multiInstance: false,
    });

    expect(first.disposition).toBe('open-window-group');
    expect(second).toMatchObject({
      disposition: 'reuse',
      carrier: 'window-group',
      panelName: '@ce/log.log',
    });
    expect(wm.getSnapshot().windows).toHaveLength(2);
  });

  it('opens a fresh non-multi-instance panel after its window-group is destroyed', () => {
    const first = wm.openPanel({
      panelName: '@ce/log.log',
      layout: { type: 'leaf', panel: '@ce/log.log' },
      entry: 'secondary.html',
      multiInstance: false,
    });
    if (!first.windowGroupId) throw new Error('expected first openPanel to create a window-group');

    wm.destroy(first.windowGroupId);

    const second = wm.openPanel({
      panelName: '@ce/log.log',
      layout: { type: 'leaf', panel: '@ce/log.log' },
      entry: 'secondary.html',
      multiInstance: false,
    });

    expect(second).toMatchObject({
      disposition: 'open-window-group',
      carrier: 'window-group',
      panelName: '@ce/log.log',
    });
    expect(second.windowGroupId).not.toBe(first.windowGroupId);
    expect(second.panelInstanceId).not.toBe(first.panelInstanceId);
    expect(wm.getSnapshot().panelInstances).toEqual([
      expect.objectContaining({ id: second.panelInstanceId }),
    ]);
  });

  it('creates a new instance for multi-instance panels', () => {
    const first = wm.openPanel({
      panelName: '@ce/plugin-detail.detail',
      layout: { type: 'leaf', panel: '@ce/plugin-detail.detail' },
      entry: 'secondary.html',
      multiInstance: true,
    });
    const second = wm.openPanel({
      panelName: '@ce/plugin-detail.detail',
      layout: { type: 'leaf', panel: '@ce/plugin-detail.detail' },
      entry: 'secondary.html',
      multiInstance: true,
    });

    expect(first.disposition).toBe('open-window-group');
    expect(second.disposition).toBe('open-window-group');
    expect(first.panelInstanceId).not.toBe(second.panelInstanceId);
    expect(wm.getSnapshot().windows).toHaveLength(3);
  });

  it('marks a pending instance as floating when popup creation fails', () => {
    const opened = wm.openPanel({
      panelName: '@ce/log.log',
      layout: { type: 'leaf', panel: '@ce/log.log' },
      entry: 'secondary.html',
      multiInstance: true,
    });

    const fallback = wm.markFloating(opened.panelInstanceId);

    expect(fallback).toMatchObject({
      id: opened.panelInstanceId,
      carrier: 'floating',
      state: 'open',
      windowGroupId: null,
    });
    expect(wm.getSnapshot().panelInstances).toEqual([
      expect.objectContaining({ id: opened.panelInstanceId, carrier: 'floating' }),
    ]);
  });

  it('marks a pending window-group and its panel instance as open after entry load ack', () => {
    const opened = wm.openPanel({
      panelName: '@ce/log.log',
      layout: { type: 'leaf', panel: '@ce/log.log' },
      entry: 'secondary.html',
      multiInstance: true,
    });
    if (!opened.windowGroupId) throw new Error('expected openPanel to create a window-group');

    expect(wm.getSnapshot().windows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: opened.windowGroupId, state: 'opening' }),
    ]));
    expect(wm.getSnapshot().panelInstances).toEqual([
      expect.objectContaining({ id: opened.panelInstanceId, state: 'opening' }),
    ]);

    wm.markWindowGroupOpened(opened.windowGroupId);

    expect(wm.getSnapshot().windows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: opened.windowGroupId, state: 'open' }),
    ]));
    expect(wm.getSnapshot().panelInstances).toEqual([
      expect.objectContaining({ id: opened.panelInstanceId, state: 'open' }),
    ]);
  });

  it('closes a panel instance and removes empty secondary groups', () => {
    const opened = wm.openPanel({
      panelName: '@ce/log.log',
      layout: { type: 'leaf', panel: '@ce/log.log' },
      entry: 'secondary.html',
      multiInstance: true,
    });

    wm.closePanelInstance(opened.panelInstanceId);

    expect(wm.getSnapshot().panelInstances).toEqual([]);
    expect(wm.getSnapshot().windows).toEqual([
      expect.objectContaining({ id: 'main-window', kind: 'main' }),
    ]);
  });
});
