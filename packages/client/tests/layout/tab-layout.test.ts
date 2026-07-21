import { describe, expect, it } from 'vitest';
import type { LayoutNode, PanelDescriptor } from '../../src/core/session';
import {
  createEditorLayout,
  commitCrossWindowTabDrop,
  commitTabDrop,
  dockFloatingPanel,
  normalizeDropDescriptor,
  removeTabFromLayout,
  serializeTabDragPayload,
  type DropDescriptor,
  type EditorGroupNode,
  type EditorLayoutNode,
  type TabDragPayload,
} from '../../src/layout/tab-layout';

const panelMap = new Map<string, PanelDescriptor>([
  ['@itharbors/files.list', { name: '@itharbors/files.list', entry: '/files.html' }],
  ['@itharbors/search.search', { name: '@itharbors/search.search', entry: '/search.html' }],
  ['@itharbors/editor.main', { name: '@itharbors/editor.main', entry: '/editor.html' }],
  ['@itharbors/preview.preview', { name: '@itharbors/preview.preview', entry: '/preview.html' }],
  ['@itharbors/status-bar.status', { name: '@itharbors/status-bar.status', entry: '/status.html' }],
]);

function createLayout(): LayoutNode {
  return {
    type: 'hsplit',
    sizes: [240, 1],
    children: [
      {
        type: 'tab',
        activeIndex: 0,
        children: [
          { type: 'leaf', panel: '@itharbors/files.list' },
          { type: 'leaf', panel: '@itharbors/search.search' },
        ],
      },
      {
        type: 'tab',
        activeIndex: 0,
        children: [
          { type: 'leaf', panel: '@itharbors/editor.main' },
          { type: 'leaf', panel: '@itharbors/preview.preview' },
        ],
      },
    ],
  };
}

function firstGroup(layout: EditorLayoutNode): EditorGroupNode {
  return (layout as Extract<EditorLayoutNode, { kind: 'split' }>).children[0] as EditorGroupNode;
}

function secondGroup(layout: EditorLayoutNode): EditorGroupNode {
  return (layout as Extract<EditorLayoutNode, { kind: 'split' }>).children[1] as EditorGroupNode;
}

describe('tab-layout', () => {
  it('normalizes bootstrap tab/leaf nodes into editor groups with stable ids', () => {
    const layout = createEditorLayout(createLayout(), panelMap, 'session-a', 'window-main');
    const left = firstGroup(layout);
    const right = secondGroup(layout);

    expect(left.kind).toBe('group');
    expect(left.tabs.map((tab) => tab.title)).toEqual(['List', 'Search']);
    expect(left.activeTabId).toBe(left.tabs[0].tabId);
    expect(right.tabs.map((tab) => tab.title)).toEqual(['Main', 'Preview']);
    expect(right.tabs[0].sessionId).toBe('session-a');
    expect(right.tabs[0].windowId).toBe('window-main');
  });

  it('moves a tab before a target tab and activates it in the target group', () => {
    const layout = createEditorLayout(createLayout(), panelMap, 'session-a', 'window-main');
    const source = firstGroup(layout).tabs[1];
    const target = secondGroup(layout).tabs[0];

    const descriptor: DropDescriptor = {
      kind: 'insert-tab',
      targetSessionId: 'session-a',
      targetWindowId: 'window-main',
      targetGroupId: secondGroup(layout).groupId,
      targetTabId: target.tabId,
      placement: 'before',
    };

    const next = commitTabDrop(layout, source.tabId, descriptor);
    const right = secondGroup(next);

    expect(right.tabs.map((tab) => tab.title)).toEqual(['Search', 'Main', 'Preview']);
    expect(right.activeTabId).toBe(source.tabId);
  });

  it('creates a new split group on edge drop and removes an empty source group', () => {
    const layout = createEditorLayout(createLayout(), panelMap, 'session-a', 'window-main');
    const source = firstGroup(layout).tabs[0];

    const next = commitTabDrop(layout, source.tabId, {
      kind: 'split-group',
      targetSessionId: 'session-a',
      targetWindowId: 'window-main',
      targetGroupId: secondGroup(layout).groupId,
      direction: 'right',
    });

    const root = next as Extract<EditorLayoutNode, { kind: 'split' }>;
    expect(root.kind).toBe('split');
    expect(root.direction).toBe('row');
    expect(root.children).toHaveLength(3);
    expect((root.children[2] as EditorGroupNode).tabs.map((tab) => tab.title)).toEqual(['List']);
  });

  it('collapses single-child splits after the source group becomes empty', () => {
    const layout = createEditorLayout({
      type: 'hsplit',
      sizes: [1, 1],
      children: [
        { type: 'leaf', panel: '@itharbors/files.list' },
        { type: 'leaf', panel: '@itharbors/editor.main' },
      ],
    }, panelMap, 'session-a', 'window-main');

    const left = firstGroup(layout);
    const right = secondGroup(layout);
    const next = commitTabDrop(layout, left.tabs[0].tabId, {
      kind: 'insert-tab',
      targetSessionId: 'session-a',
      targetWindowId: 'window-main',
      targetGroupId: right.groupId,
      targetTabId: right.tabs[0].tabId,
      placement: 'before',
    });

    expect(next.kind).toBe('group');
    expect((next as EditorGroupNode).tabs.map((tab) => tab.title)).toEqual(['List', 'Main']);
  });

  it('treats an unchanged insertion position as a no-op', () => {
    const layout = createEditorLayout(createLayout(), panelMap, 'session-a', 'window-main');
    const group = firstGroup(layout);
    const source = group.tabs[0];
    const descriptor: DropDescriptor = {
      kind: 'insert-tab',
      targetSessionId: 'session-a',
      targetWindowId: 'window-main',
      targetGroupId: group.groupId,
      targetTabId: group.tabs[1].tabId,
      placement: 'before',
    };

    expect(normalizeDropDescriptor(layout, source.tabId, descriptor)).toBeNull();
  });

  it('serializeTabDragPayload returns a payload with type/sessionId/source ids and a serializable tab snapshot', () => {
    const layout = createEditorLayout(createLayout(), panelMap, 'session-a', 'window-main');
    const sourceGroup = firstGroup(layout);
    const sourceTab = sourceGroup.tabs[1];

    const payload = serializeTabDragPayload(layout, {
      sessionId: 'session-a',
      sourceWindowId: 'window-main',
      sourceGroupId: sourceGroup.groupId,
      sourceTabId: sourceTab.tabId,
    });

    expect(payload).toEqual({
      type: 'ce/tab-drag',
      sessionId: 'session-a',
      sourceWindowId: 'window-main',
      sourceGroupId: sourceGroup.groupId,
      sourceTabId: sourceTab.tabId,
      tab: {
        title: 'Search',
        titleKey: undefined,
        panelName: '@itharbors/search.search',
        panelType: 'iframe',
        src: '/search.html',
        content: { type: 'leaf', panel: '@itharbors/search.search' },
      },
    });
    expect(payload?.tab).not.toHaveProperty('tabId');
    expect(payload?.tab.content).not.toBe(sourceTab.content);
  });

  it('serializeTabDragPayload returns null when the source identifiers do not match the source tab runtime ownership', () => {
    const layout = createEditorLayout(createLayout(), panelMap, 'session-a', 'window-main');
    const sourceGroup = firstGroup(layout);
    const sourceTab = sourceGroup.tabs[1];

    expect(serializeTabDragPayload(layout, {
      sessionId: 'session-b',
      sourceWindowId: 'window-main',
      sourceGroupId: sourceGroup.groupId,
      sourceTabId: sourceTab.tabId,
    })).toBeNull();

    expect(serializeTabDragPayload(layout, {
      sessionId: 'session-a',
      sourceWindowId: 'window-other',
      sourceGroupId: sourceGroup.groupId,
      sourceTabId: sourceTab.tabId,
    })).toBeNull();

    expect(serializeTabDragPayload(layout, {
      sessionId: 'session-a',
      sourceWindowId: 'window-main',
      sourceGroupId: 'group-other',
      sourceTabId: sourceTab.tabId,
    })).toBeNull();
  });

  it('commitCrossWindowTabDrop inserts a dragged tab into a target group using target-local runtime ids', () => {
    const sourceLayout = createEditorLayout(createLayout(), panelMap, 'session-a', 'window-source');
    const targetLayout = createEditorLayout(createLayout(), panelMap, 'session-a', 'window-target');
    const sourceGroup = firstGroup(sourceLayout);
    const targetGroup = secondGroup(targetLayout);
    const payload = serializeTabDragPayload(sourceLayout, {
      sessionId: 'session-a',
      sourceWindowId: 'window-source',
      sourceGroupId: sourceGroup.groupId,
      sourceTabId: sourceGroup.tabs[1].tabId,
    });

    expect(payload).not.toBeNull();

    const next = commitCrossWindowTabDrop(targetLayout, payload!, {
      kind: 'insert-tab',
      targetSessionId: 'session-a',
      targetWindowId: 'window-target',
      targetGroupId: targetGroup.groupId,
      targetTabId: targetGroup.tabs[0].tabId,
      placement: 'before',
    });
    const right = secondGroup(next);
    const inserted = right.tabs[0];

    expect(right.tabs.map((tab) => tab.title)).toEqual(['Search', 'Main', 'Preview']);
    expect(right.activeTabId).toBe(inserted.tabId);
    expect(inserted).toEqual(expect.objectContaining({
      sessionId: 'session-a',
      windowId: 'window-target',
      groupId: targetGroup.groupId,
      title: 'Search',
      panelName: '@itharbors/search.search',
      panelType: 'iframe',
      content: { type: 'leaf', panel: '@itharbors/search.search' },
    }));
    expect(inserted.tabId).not.toBe(sourceGroup.tabs[1].tabId);
    expect(inserted.content).not.toBe(payload?.tab.content);
  });

  it('commitCrossWindowTabDrop supports split-group for cross-window drops', () => {
    const sourceLayout = createEditorLayout(createLayout(), panelMap, 'session-a', 'window-source');
    const targetLayout = createEditorLayout(createLayout(), panelMap, 'session-a', 'window-target');
    const sourceGroup = firstGroup(sourceLayout);
    const targetGroup = secondGroup(targetLayout);
    const payload = serializeTabDragPayload(sourceLayout, {
      sessionId: 'session-a',
      sourceWindowId: 'window-source',
      sourceGroupId: sourceGroup.groupId,
      sourceTabId: sourceGroup.tabs[0].tabId,
    });

    expect(payload).not.toBeNull();

    const next = commitCrossWindowTabDrop(targetLayout, payload!, {
      kind: 'split-group',
      targetSessionId: 'session-a',
      targetWindowId: 'window-target',
      targetGroupId: targetGroup.groupId,
      direction: 'right',
    });

    const root = next as Extract<EditorLayoutNode, { kind: 'split' }>;
    expect(root.children).toHaveLength(3);
    const insertedGroup = root.children[2] as EditorGroupNode;
    expect(insertedGroup.tabs.map((tab) => tab.title)).toEqual(['List']);
    expect(insertedGroup.sessionId).toBe('session-a');
    expect(insertedGroup.windowId).toBe('window-target');
    expect(insertedGroup.tabs[0]).toEqual(expect.objectContaining({
      sessionId: 'session-a',
      windowId: 'window-target',
      groupId: insertedGroup.groupId,
      title: 'List',
    }));
  });

  it('commitCrossWindowTabDrop returns the original layout when the payload session does not match the target session', () => {
    const sourceLayout = createEditorLayout(createLayout(), panelMap, 'session-a', 'window-source');
    const targetLayout = createEditorLayout(createLayout(), panelMap, 'session-a', 'window-target');
    const sourceGroup = firstGroup(sourceLayout);
    const targetGroup = secondGroup(targetLayout);
    const payload = serializeTabDragPayload(sourceLayout, {
      sessionId: 'session-a',
      sourceWindowId: 'window-source',
      sourceGroupId: sourceGroup.groupId,
      sourceTabId: sourceGroup.tabs[0].tabId,
    });

    expect(payload).not.toBeNull();

    const next = commitCrossWindowTabDrop(targetLayout, { ...payload!, sessionId: 'session-b' }, {
      kind: 'insert-tab',
      targetSessionId: 'session-a',
      targetWindowId: 'window-target',
      targetGroupId: targetGroup.groupId,
      targetTabId: targetGroup.tabs[0].tabId,
      placement: 'before',
    });

    expect(next).toBe(targetLayout);
  });

  it('commitCrossWindowTabDrop accepts payloads after a JSON round-trip', () => {
    const sourceLayout = createEditorLayout({
      type: 'tab',
      activeIndex: 0,
      children: [{
        type: 'hsplit',
        sizes: [240, 1],
        children: [
          { type: 'leaf', panel: '@itharbors/files.list' },
          {
            type: 'tab',
            activeIndex: 1,
            children: [
              { type: 'leaf', panel: '@itharbors/editor.main' },
              { type: 'leaf', panel: '@itharbors/preview.preview' },
            ],
          },
        ],
      }],
    }, panelMap, 'session-a', 'window-source');
    const targetLayout = createEditorLayout(createLayout(), panelMap, 'session-a', 'window-target');
    const sourceGroup = sourceLayout as EditorGroupNode;
    const targetGroup = secondGroup(targetLayout);
    const payload = serializeTabDragPayload(sourceLayout, {
      sessionId: 'session-a',
      sourceWindowId: 'window-source',
      sourceGroupId: sourceGroup.groupId,
      sourceTabId: sourceGroup.tabs[0].tabId,
    });

    expect(payload).not.toBeNull();

    const roundTrippedPayload = JSON.parse(JSON.stringify(payload)) as TabDragPayload;
    const next = commitCrossWindowTabDrop(targetLayout, roundTrippedPayload, {
      kind: 'insert-tab',
      targetSessionId: 'session-a',
      targetWindowId: 'window-target',
      targetGroupId: targetGroup.groupId,
      targetTabId: targetGroup.tabs[0].tabId,
      placement: 'before',
    });
    const right = secondGroup(next);
    const inserted = right.tabs[0];

    expect(right.tabs.map((tab) => tab.title)).toEqual(['Group', 'Main', 'Preview']);
    expect(inserted).toEqual(expect.objectContaining({
      title: 'Group',
      panelName: 'layout-0-0',
      sessionId: 'session-a',
      windowId: 'window-target',
      groupId: targetGroup.groupId,
      panelType: 'iframe',
      content: {
        type: 'hsplit',
        sizes: [240, 1],
        children: [
          { type: 'leaf', panel: '@itharbors/files.list' },
          {
            type: 'tab',
            activeIndex: 1,
            children: [
              { type: 'leaf', panel: '@itharbors/editor.main' },
              { type: 'leaf', panel: '@itharbors/preview.preview' },
            ],
          },
        ],
      },
    }));
  });

  it('commitCrossWindowTabDrop returns the original layout for malformed payload objects', () => {
    const sourceLayout = createEditorLayout(createLayout(), panelMap, 'session-a', 'window-source');
    const targetLayout = createEditorLayout(createLayout(), panelMap, 'session-a', 'window-target');
    const sourceGroup = firstGroup(sourceLayout);
    const targetGroup = secondGroup(targetLayout);
    const payload = serializeTabDragPayload(sourceLayout, {
      sessionId: 'session-a',
      sourceWindowId: 'window-source',
      sourceGroupId: sourceGroup.groupId,
      sourceTabId: sourceGroup.tabs[0].tabId,
    });

    expect(payload).not.toBeNull();

    const invalidPayloads: unknown[] = [
      {
        ...payload!,
        type: 'ce/other-drag',
      },
      {
        ...payload!,
        sessionId: 123,
      },
      {
        ...payload!,
        sourceWindowId: 123,
      },
      {
        ...payload!,
        sourceGroupId: 123,
      },
      {
        ...payload!,
        sourceTabId: 123,
      },
      {
        ...payload!,
        unexpected: 'extra-field',
      },
      {
        ...payload!,
        tab: { ...payload!.tab, panelType: 'panel' },
      },
      {
        ...payload!,
        tab: { ...payload!.tab, extra: 'extra-field' },
      },
      {
        ...payload!,
        tab: { ...payload!.tab, content: { type: 'tab', activeIndex: 0, children: [] } },
      },
      {
        ...payload!,
        tab: { ...payload!.tab, content: { type: 'tab', activeIndex: -1, children: [{ type: 'leaf', panel: '@itharbors/files.list' }] } },
      },
      {
        ...payload!,
        tab: { ...payload!.tab, content: { type: 'tab', activeIndex: 1, children: [{ type: 'leaf', panel: '@itharbors/files.list' }] } },
      },
      {
        ...payload!,
        tab: { ...payload!.tab, content: { type: 'hsplit', children: [] } },
      },
      {
        ...payload!,
        tab: {
          ...payload!.tab,
          content: {
            type: 'vsplit',
            children: [
              { type: 'leaf', panel: '@itharbors/files.list' },
              { type: 'leaf', panel: '@itharbors/search.search' },
            ],
            sizes: [1],
          },
        },
      },
      {
        ...payload!,
        tab: {
          ...payload!.tab,
          content: {
            type: 'vsplit',
            children: [
              { type: 'leaf', panel: '@itharbors/files.list' },
              { type: 'leaf', panel: '@itharbors/search.search' },
            ],
            sizes: [Number.NaN, 1],
          },
        },
      },
      {
        ...payload!,
        tab: {
          ...payload!.tab,
          content: {
            type: 'vsplit',
            children: [
              { type: 'leaf', panel: '@itharbors/files.list' },
              { type: 'leaf', panel: '@itharbors/search.search' },
            ],
            sizes: [Number.POSITIVE_INFINITY, 1],
          },
        },
      },
    ];

    for (const invalidPayload of invalidPayloads) {
      const next = commitCrossWindowTabDrop(targetLayout, invalidPayload as TabDragPayload, {
        kind: 'insert-tab',
        targetSessionId: 'session-a',
        targetWindowId: 'window-target',
        targetGroupId: targetGroup.groupId,
        targetTabId: targetGroup.tabs[0].tabId,
        placement: 'before',
      });

      expect(next).toBe(targetLayout);
    }
  });

  it('commitCrossWindowTabDrop returns the original layout when used for the same window', () => {
    const sourceLayout = createEditorLayout(createLayout(), panelMap, 'session-a', 'window-target');
    const targetLayout = createEditorLayout(createLayout(), panelMap, 'session-a', 'window-target');
    const sourceGroup = firstGroup(sourceLayout);
    const targetGroup = secondGroup(targetLayout);
    const payload = serializeTabDragPayload(sourceLayout, {
      sessionId: 'session-a',
      sourceWindowId: 'window-target',
      sourceGroupId: sourceGroup.groupId,
      sourceTabId: sourceGroup.tabs[0].tabId,
    });

    expect(payload).not.toBeNull();

    const next = commitCrossWindowTabDrop(targetLayout, payload!, {
      kind: 'insert-tab',
      targetSessionId: 'session-a',
      targetWindowId: 'window-target',
      targetGroupId: targetGroup.groupId,
      targetTabId: targetGroup.tabs[0].tabId,
      placement: 'before',
    });

    expect(next).toBe(targetLayout);
  });

  it('commitCrossWindowTabDrop returns the original layout when the target descriptor does not resolve to a target group in the same session/window', () => {
    const sourceLayout = createEditorLayout(createLayout(), panelMap, 'session-a', 'window-source');
    const targetLayout = createEditorLayout(createLayout(), panelMap, 'session-a', 'window-target');
    const sourceGroup = firstGroup(sourceLayout);
    const payload = serializeTabDragPayload(sourceLayout, {
      sessionId: 'session-a',
      sourceWindowId: 'window-source',
      sourceGroupId: sourceGroup.groupId,
      sourceTabId: sourceGroup.tabs[0].tabId,
    });

    expect(payload).not.toBeNull();

    const mismatchedWindow = commitCrossWindowTabDrop(targetLayout, payload!, {
      kind: 'insert-tab',
      targetSessionId: 'session-a',
      targetWindowId: 'window-other',
      targetGroupId: secondGroup(targetLayout).groupId,
      targetTabId: secondGroup(targetLayout).tabs[0].tabId,
      placement: 'before',
    });
    const missingGroup = commitCrossWindowTabDrop(targetLayout, payload!, {
      kind: 'split-group',
      targetSessionId: 'session-a',
      targetWindowId: 'window-target',
      targetGroupId: 'group-missing',
      direction: 'right',
    });

    expect(mismatchedWindow).toBe(targetLayout);
    expect(missingGroup).toBe(targetLayout);
  });

  it('removeTabFromLayout removes a tab and collapses empty groups', () => {
    const layout = createEditorLayout({
      type: 'hsplit',
      sizes: [1, 1],
      children: [
        { type: 'leaf', panel: '@itharbors/files.list' },
        { type: 'leaf', panel: '@itharbors/editor.main' },
      ],
    }, panelMap, 'session-a', 'window-main');

    const left = firstGroup(layout);
    const next = removeTabFromLayout(layout, left.tabs[0].tabId);

    expect(next.kind).toBe('group');
    expect((next as EditorGroupNode).tabs.map((tab) => tab.title)).toEqual(['Main']);
  });

  it('docks a floating panel into a target tab group', () => {
    const layout = createEditorLayout(createLayout(), panelMap, 'session-a', 'window-main');
    const target = firstGroup(layout).tabs[0];

    const next = dockFloatingPanel(layout, {
      panelName: '@itharbors/preview.preview',
      title: 'Preview',
      src: '/preview.html?sessionId=session-a',
    }, {
      kind: 'insert-tab',
      targetSessionId: 'session-a',
      targetWindowId: 'window-main',
      targetGroupId: firstGroup(layout).groupId,
      targetTabId: target.tabId,
      placement: 'after',
    });

    const left = firstGroup(next);
    expect(left.tabs.map((tab) => tab.title)).toEqual(['List', 'Preview', 'Search']);
    expect(left.activeTabId).toBe(left.tabs[1].tabId);
    expect(left.tabs[1]).toEqual(expect.objectContaining({
      tabId: expect.stringMatching(/^tab-floating-/),
      panelName: '@itharbors/preview.preview',
      sessionId: 'session-a',
      windowId: 'window-main',
      groupId: firstGroup(layout).groupId,
    }));
  });
});
