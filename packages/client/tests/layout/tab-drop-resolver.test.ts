import { describe, expect, it } from 'vitest';
import { resolveDropDescriptor } from '../../src/layout/tab-drop-resolver';

const target = {
  sessionId: 'session-a',
  windowId: 'window-main',
  groupId: 'group-right',
  tabStripRect: { left: 100, right: 300, top: 0, bottom: 32 },
  contentRect: { left: 100, right: 300, top: 32, bottom: 232 },
  tabs: [
    { tabId: 'tab-main', left: 100, right: 180 },
    { tabId: 'tab-preview', left: 180, right: 260 },
  ],
};

describe('tab-drop-resolver', () => {
  it('returns before when pointer is on the left half of a tab', () => {
    expect(resolveDropDescriptor({
      sourceSessionId: 'session-a',
      sourceGroupId: 'group-left',
      sourceTabId: 'tab-search',
      target,
      clientX: 120,
      clientY: 16,
    })).toEqual({
      kind: 'insert-tab',
      targetSessionId: 'session-a',
      targetWindowId: 'window-main',
      targetGroupId: 'group-right',
      targetTabId: 'tab-main',
      placement: 'before',
    });
  });

  it('returns after when pointer is on the right half of a tab', () => {
    expect(resolveDropDescriptor({
      sourceSessionId: 'session-a',
      sourceGroupId: 'group-left',
      sourceTabId: 'tab-search',
      target,
      clientX: 250,
      clientY: 16,
    })).toEqual({
      kind: 'insert-tab',
      targetSessionId: 'session-a',
      targetWindowId: 'window-main',
      targetGroupId: 'group-right',
      targetTabId: 'tab-preview',
      placement: 'after',
    });
  });

  it('returns split-group for top edge hits', () => {
    expect(resolveDropDescriptor({
      sourceSessionId: 'session-a',
      sourceGroupId: 'group-left',
      sourceTabId: 'tab-search',
      target,
      clientX: 160,
      clientY: 40,
    })).toEqual({
      kind: 'split-group',
      targetSessionId: 'session-a',
      targetWindowId: 'window-main',
      targetGroupId: 'group-right',
      direction: 'top',
    });
  });

  it('returns null for panel center hits', () => {
    expect(resolveDropDescriptor({
      sourceSessionId: 'session-a',
      sourceGroupId: 'group-left',
      sourceTabId: 'tab-search',
      target,
      clientX: 200,
      clientY: 140,
    })).toBeNull();
  });

  it('returns null for foreign session targets', () => {
    expect(resolveDropDescriptor({
      sourceSessionId: 'session-a',
      sourceGroupId: 'group-left',
      sourceTabId: 'tab-search',
      target: { ...target, sessionId: 'session-b' },
      clientX: 120,
      clientY: 16,
    })).toBeNull();
  });
});
