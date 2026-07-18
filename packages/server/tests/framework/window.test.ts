import { describe, it, expect, beforeEach } from 'vitest';
import { WindowManager } from '../../src/framework/window/index';
import type { LegacyWindowDescriptorInput, LayoutNode } from '../../src/framework/window/types';

describe('WindowManager', () => {
  let wm: WindowManager;

  beforeEach(() => {
    wm = new WindowManager();
  });

  it('create returns an id and stores the window', () => {
    const id = wm.create({ id: '', type: 'sidebar', title: 'Explorer', layout: { type: 'leaf', panel: 'explorer.tree' } });
    expect(id).toBeTruthy();
    expect(wm.get(id)?.title).toBe('Explorer');
    expect(wm.getSnapshot().windows).toEqual([
      {
        id,
        kind: 'secondary',
        type: 'panel-area',
        entry: '',
        state: 'open',
        layout: { type: 'leaf', panel: 'explorer.tree' },
        panelInstanceIds: [],
      },
    ]);
  });

  it('create uses provided id', () => {
    expect(wm.create({ id: 'main', type: 'panel-area', layout: { type: 'leaf', panel: 'editor.main' } })).toBe('main');
  });

  it('keeps all kit default windows provided by the loader', () => {
    wm = new WindowManager({
      secondaryEntry: 'secondary.html',
      defaultWindows: [
        {
          id: 'main',
          kind: 'main',
          type: 'panel-area',
          entry: 'main.html',
          state: 'open',
          layout: { type: 'leaf', panel: 'editor.main' },
          panelInstanceIds: [],
        },
        {
          id: 'tools',
          kind: 'secondary',
          type: 'panel-area',
          entry: 'secondary.html',
          state: 'open',
          layout: { type: 'leaf', panel: 'editor.tools' },
          panelInstanceIds: [],
        },
      ],
    });

    expect(wm.getSnapshot().windows.map((windowGroup) => windowGroup.id)).toEqual(['main', 'tools']);
  });

  it('list and destroy manage windows', () => {
    const desc: LegacyWindowDescriptorInput = { id: 'w1', type: 'panel-area', layout: { type: 'leaf', panel: 'a.panel' } };
    wm.create(desc);
    expect(wm.list()).toHaveLength(1);
    wm.destroy('w1');
    expect(wm.list()).toHaveLength(0);
  });

  it('supports nested layout trees', () => {
    wm.create({
      id: 'split',
      type: 'panel-area',
      layout: { type: 'hsplit', sizes: [0.5, 0.5], children: [{ type: 'leaf', panel: 'a' }, { type: 'leaf', panel: 'b' }] },
    });
    expect(wm.get('split')?.layout.type).toBe('hsplit');
  });

  it('marks a pending secondary window and panel instance as open', () => {
    const opened = wm.openPanel({
      panelName: 'a.panel',
      layout: { type: 'leaf', panel: 'a.panel' },
      entry: 'secondary.html',
      multiInstance: true,
    });
    if (!opened.windowGroupId) throw new Error('expected openPanel to create a window-group');

    wm.markWindowGroupOpened(opened.windowGroupId);

    expect(wm.getSnapshot().windows).toEqual([
      expect.objectContaining({ id: opened.windowGroupId, state: 'open' }),
    ]);
    expect(wm.getSnapshot().panelInstances).toEqual([
      expect.objectContaining({ id: opened.panelInstanceId, state: 'open' }),
    ]);
  });

  it('closes a secondary window group and removes its panel instances', () => {
    const opened = wm.openPanel({
      panelName: 'a.panel',
      layout: { type: 'leaf', panel: 'a.panel' },
      entry: 'secondary.html',
      multiInstance: false,
    });
    if (!opened.windowGroupId) throw new Error('expected openPanel to create a window-group');

    wm.closeWindowGroup(opened.windowGroupId);

    expect(wm.getSnapshot().windows).toEqual([]);
    expect(wm.getSnapshot().panelInstances).toEqual([]);
  });

  it('does not reuse a non-multi panel after its secondary window was reclaimed', () => {
    const first = wm.openPanel({
      panelName: 'a.panel',
      layout: { type: 'leaf', panel: 'a.panel' },
      entry: 'secondary.html',
      multiInstance: false,
    });
    if (!first.windowGroupId) throw new Error('expected openPanel to create a window-group');

    wm.closeWindowGroup(first.windowGroupId);
    const second = wm.openPanel({
      panelName: 'a.panel',
      layout: { type: 'leaf', panel: 'a.panel' },
      entry: 'secondary.html',
      multiInstance: false,
    });

    expect(second.disposition).toBe('open-window-group');
    expect(second.panelInstanceId).not.toBe(first.panelInstanceId);
  });

  it('updates floating panel instance state', () => {
    const opened = wm.openPanel({
      panelName: 'a.panel',
      layout: { type: 'leaf', panel: 'a.panel' },
      entry: 'secondary.html',
      multiInstance: true,
    });

    wm.markFloating(opened.panelInstanceId);
    wm.setPanelInstanceState(opened.panelInstanceId, 'minimized');

    expect(wm.getSnapshot().panelInstances).toEqual([
      expect.objectContaining({ id: opened.panelInstanceId, carrier: 'floating', state: 'minimized' }),
    ]);
  });
});

describe('WindowManager.rearrange', () => {
  let wm: WindowManager;

  beforeEach(() => {
    wm = new WindowManager({
      secondaryEntry: 'secondary.html',
      defaultWindows: [
        {
          id: 'main',
          kind: 'main',
          type: 'panel-area',
          entry: 'main.html',
          state: 'open',
          layout: {
            type: 'vsplit',
            children: [
              { type: 'leaf', panel: 'explorer' },
              { type: 'leaf', panel: 'editor' },
            ],
          },
          panelInstanceIds: [],
        },
      ],
    });
  });

  it('replaces the layout tree of the target window', () => {
    const newLayout: LayoutNode = {
      type: 'hsplit',
      children: [
        { type: 'leaf', panel: 'editor' },
        { type: 'leaf', panel: 'terminal' },
      ],
    };

    const updated = wm.rearrange('main', newLayout);

    expect(updated.layout).toEqual(newLayout);
    expect(wm.get('main')?.layout).toEqual(newLayout);
  });

  it('throws when the window does not exist', () => {
    expect(() => wm.rearrange('nonexistent', { type: 'leaf', panel: 'x' })).toThrow(/not found/);
  });

  it('returns the updated window descriptor', () => {
    const updated = wm.rearrange('main', { type: 'leaf', panel: 'only' });

    expect(updated).toMatchObject({
      id: 'main',
      kind: 'main',
      layout: { type: 'leaf', panel: 'only' },
    });
  });

  it('is idempotent when the same layout is applied', () => {
    const layout: LayoutNode = { type: 'leaf', panel: 'same' };
    wm.rearrange('main', layout);
    const updated = wm.rearrange('main', layout);

    expect(updated.layout).toEqual(layout);
  });
});
