import type { DropDescriptor } from './tab-layout';

export interface TabStripTarget {
  tabId: string;
  left: number;
  right: number;
}

export interface GroupDropTarget {
  sessionId: string;
  windowId: string;
  groupId: string;
  tabStripRect: { left: number; right: number; top: number; bottom: number };
  contentRect: { left: number; right: number; top: number; bottom: number };
  tabs: TabStripTarget[];
}

export function resolveDropDescriptor(input: {
  sourceSessionId: string;
  sourceGroupId: string;
  sourceTabId: string;
  target: GroupDropTarget;
  clientX: number;
  clientY: number;
}): DropDescriptor | null {
  const { sourceSessionId, target, clientX, clientY } = input;
  if (sourceSessionId !== target.sessionId) return null;

  if (containsPoint(target.tabStripRect, clientX, clientY)) {
    const tab = target.tabs.find((candidate) => clientX >= candidate.left && clientX <= candidate.right);
    if (!tab) return null;

    const midpoint = (tab.left + tab.right) / 2;
    return {
      kind: 'insert-tab',
      targetSessionId: target.sessionId,
      targetWindowId: target.windowId,
      targetGroupId: target.groupId,
      targetTabId: tab.tabId,
      placement: clientX < midpoint ? 'before' : 'after',
    };
  }

  if (!containsPoint(target.contentRect, clientX, clientY)) {
    return null;
  }

  const width = target.contentRect.right - target.contentRect.left;
  const height = target.contentRect.bottom - target.contentRect.top;
  const leftDistance = clientX - target.contentRect.left;
  const rightDistance = target.contentRect.right - clientX;
  const topDistance = clientY - target.contentRect.top;
  const bottomDistance = target.contentRect.bottom - clientY;
  const thresholdX = width * 0.25;
  const thresholdY = height * 0.25;

  const candidates = [
    { direction: 'left', value: leftDistance, enabled: leftDistance <= thresholdX },
    { direction: 'right', value: rightDistance, enabled: rightDistance <= thresholdX },
    { direction: 'top', value: topDistance, enabled: topDistance <= thresholdY },
    { direction: 'bottom', value: bottomDistance, enabled: bottomDistance <= thresholdY },
  ].filter((candidate) => candidate.enabled);

  if (candidates.length === 0) return null;

  const match = candidates.sort((a, b) => a.value - b.value)[0];
  return {
    kind: 'split-group',
    targetSessionId: target.sessionId,
    targetWindowId: target.windowId,
    targetGroupId: target.groupId,
    direction: match.direction as 'top' | 'bottom' | 'left' | 'right',
  };
}

function containsPoint(
  rect: { left: number; right: number; top: number; bottom: number },
  x: number,
  y: number,
): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}
