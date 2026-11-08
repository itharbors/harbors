import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WindowManager } from '../window/index';

const MAIN_LAYOUT = {
  type: 'leaf',
  panel: 'log.log',
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
          layout: { type: 'leaf', panel: 'message-debug.debug' },
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
      panelName: 'log.log',
      layout: { type: 'leaf', panel: 'log.log' },
      entry: 'secondary.html',
      multiInstance: false,
    });
    const second = wm.openPanel({
      panelName: 'log.log',
      layout: { type: 'leaf', panel: 'log.log' },
      entry: 'secondary.html',
      multiInstance: false,
    });

    expect(first.disposition).toBe('open-window-group');
    expect(second).toMatchObject({
      disposition: 'reuse',
      carrier: 'window-group',
      panelName: 'log.log',
    });
    expect(wm.getSnapshot().windows).toHaveLength(2);
  });

  it('creates an independent window copy without changing another same-name instance', () => {
    const request = {
      panelName: 'log.log',
      layout: { type: 'leaf' as const, panel: 'log.log' },
      entry: 'secondary.html',
      multiInstance: false,
    };
    const existing = wm.openPanel(request);
    const before = wm.getSnapshot();
    const copy = wm.openPanel(request, { forceNew: true });
    const anotherCopy = wm.openPanel(request, { forceNew: true });
    expect(copy.disposition).toBe('open-window-group');
    expect(new Set([existing.panelInstanceId, copy.panelInstanceId, anotherCopy.panelInstanceId]).size).toBe(3);
    expect(new Set([existing.windowGroupId, copy.windowGroupId, anotherCopy.windowGroupId]).size).toBe(3);
    expect(wm.getSnapshot().panelInstances).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: copy.panelInstanceId, multiInstance: false }),
    ]));
    wm.closeWindowGroup(copy.windowGroupId!);
    wm.closeWindowGroup(anotherCopy.windowGroupId!);
    expect(wm.getSnapshot()).toEqual(before);
  });

  it('never reuses explicit copies for ordinary singleton opens, including after the original closes', () => {
    const request = {
      panelName: 'log.log',
      layout: { type: 'leaf' as const, panel: 'log.log' },
      entry: 'secondary.html',
      multiInstance: false,
    };
    const copyA = wm.openPanel(request, { forceNew: true });
    const copyB = wm.openPanel(request, { forceNew: true });
    const first = wm.openPanel(request);
    expect(first.disposition).toBe('open-window-group');
    expect([copyA.panelInstanceId, copyB.panelInstanceId]).not.toContain(first.panelInstanceId);
    expect(wm.openPanel(request)).toMatchObject({ disposition: 'reuse', panelInstanceId: first.panelInstanceId });

    wm.closeWindowGroup(first.windowGroupId!);
    const second = wm.openPanel(request);
    expect(second.disposition).toBe('open-window-group');
    expect([copyA.panelInstanceId, copyB.panelInstanceId, first.panelInstanceId]).not.toContain(second.panelInstanceId);
    wm.closeWindowGroup(copyA.windowGroupId!);
    expect(wm.openPanel(request)).toMatchObject({ disposition: 'reuse', panelInstanceId: second.panelInstanceId });
    expect(wm.getSnapshot().panelInstances).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: copyB.panelInstanceId }),
      expect.objectContaining({ id: second.panelInstanceId }),
    ]));
  });

  it('expires only unacknowledged window copies and keeps opened and ordinary instances', () => {
    vi.useFakeTimers();
    try {
      const request = { panelName: 'log.log', layout: { type: 'leaf' as const, panel: 'log.log' }, entry: 'secondary.html', multiInstance: false };
      const ordinary = wm.openPanel(request);
      const lostResponse = wm.openPanel(request, { forceNew: true });
      const opened = wm.openPanel(request, { forceNew: true });
      expect(vi.getTimerCount()).toBe(2);
      vi.advanceTimersByTime(29_999);
      expect(wm.getSnapshot().panelInstances).toHaveLength(3);
      wm.markWindowGroupOpened(opened.windowGroupId!);
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(1);
      const snapshot = wm.getSnapshot();
      expect(snapshot.panelInstances.map((instance) => instance.id)).toEqual([ordinary.panelInstanceId, opened.panelInstanceId]);
      expect(snapshot.windows.some((window) => window.id === lostResponse.windowGroupId)).toBe(false);
      expect(snapshot.windows).toEqual(expect.arrayContaining([expect.objectContaining({ id: opened.windowGroupId, state: 'open' })]));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels window-copy leases on close, destroy, floating fallback and manager clear', () => {
    vi.useFakeTimers();
    try {
      const request = { panelName: 'log.log', layout: { type: 'leaf' as const, panel: 'log.log' }, entry: 'secondary.html', multiInstance: false };
      const closed = wm.openPanel(request, { forceNew: true });
      const groupClosed = wm.openPanel(request, { forceNew: true });
      const destroyed = wm.openPanel(request, { forceNew: true });
      const floating = wm.openPanel(request, { forceNew: true });
      wm.openPanel(request, { forceNew: true });
      expect(vi.getTimerCount()).toBe(5);
      wm.closePanelInstance(closed.panelInstanceId);
      wm.closeWindowGroup(groupClosed.windowGroupId!);
      wm.destroy(destroyed.windowGroupId!);
      wm.markFloating(floating.panelInstanceId);
      expect(vi.getTimerCount()).toBe(1);
      wm.clear();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(30_000);
      expect(wm.getSnapshot()).toEqual({ windows: [], panelInstances: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens a fresh non-multi-instance panel after its window-group is destroyed', () => {
    const first = wm.openPanel({
      panelName: 'log.log',
      layout: { type: 'leaf', panel: 'log.log' },
      entry: 'secondary.html',
      multiInstance: false,
    });
    if (!first.windowGroupId) throw new Error('expected first openPanel to create a window-group');

    wm.destroy(first.windowGroupId);

    const second = wm.openPanel({
      panelName: 'log.log',
      layout: { type: 'leaf', panel: 'log.log' },
      entry: 'secondary.html',
      multiInstance: false,
    });

    expect(second).toMatchObject({
      disposition: 'open-window-group',
      carrier: 'window-group',
      panelName: 'log.log',
    });
    expect(second.windowGroupId).not.toBe(first.windowGroupId);
    expect(second.panelInstanceId).not.toBe(first.panelInstanceId);
    expect(wm.getSnapshot().panelInstances).toEqual([
      expect.objectContaining({ id: second.panelInstanceId }),
    ]);
  });

  it('creates a new instance for multi-instance panels', () => {
    const first = wm.openPanel({
      panelName: 'plugin-detail.detail',
      layout: { type: 'leaf', panel: 'plugin-detail.detail' },
      entry: 'secondary.html',
      multiInstance: true,
    });
    const second = wm.openPanel({
      panelName: 'plugin-detail.detail',
      layout: { type: 'leaf', panel: 'plugin-detail.detail' },
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
      panelName: 'log.log',
      layout: { type: 'leaf', panel: 'log.log' },
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
      panelName: 'log.log',
      layout: { type: 'leaf', panel: 'log.log' },
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
      panelName: 'log.log',
      layout: { type: 'leaf', panel: 'log.log' },
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
