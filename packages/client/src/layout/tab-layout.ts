import type { LayoutNode, PanelDescriptor } from '../core/session';
import { i18nStore } from '../i18n/store';

export type DropDescriptor =
  | {
      kind: 'insert-tab';
      targetSessionId: string;
      targetWindowId: string;
      targetGroupId: string;
      targetTabId: string;
      placement: 'before' | 'after';
    }
  | {
      kind: 'split-group';
      targetSessionId: string;
      targetWindowId: string;
      targetGroupId: string;
      direction: 'top' | 'bottom' | 'left' | 'right';
    };

export interface DragSession {
  dragId: string;
  sourceSessionId: string;
  sourceWindowId: string;
  sourceGroupId: string;
  sourceTabId: string;
  currentDescriptor: DropDescriptor | null;
  forbidden: boolean;
}

export interface EditorTab {
  tabId: string;
  sessionId: string;
  windowId: string;
  groupId: string;
  title: string;
  titleKey?: string;
  panelName: string;
  panelType: 'iframe' | 'simple';
  src?: string;
  content: LayoutNode;
}

export interface SerializedDraggedTab {
  title: string;
  titleKey?: string;
  panelName: string;
  panelType: 'iframe' | 'simple';
  src?: string;
  content: LayoutNode;
}

export interface TabDragPayload {
  type: 'ce/tab-drag';
  sessionId: string;
  sourceWindowId: string;
  sourceGroupId: string;
  sourceTabId: string;
  tab: SerializedDraggedTab;
}

export type EditorLayoutNode = EditorSplitNode | EditorGroupNode | EditorPanelNode;

export interface EditorGroupNode {
  kind: 'group';
  groupId: string;
  sessionId: string;
  windowId: string;
  tabs: EditorTab[];
  activeTabId: string | null;
}

export interface EditorPanelNode {
  kind: 'panel';
  panelId: string;
  sessionId: string;
  windowId: string;
  panelType: 'simple';
  title: string;
  titleKey?: string;
  panelName: string;
  src?: string;
}

export type EditorSplitFlexUnit = 'fr' | 'px';

export interface EditorSplitNode {
  kind: 'split';
  direction: 'row' | 'column';
  children: EditorLayoutNode[];
  sizes?: number[];
  // 标记每个子节点的尺寸语义：'px' 表示固定像素，不随窗口缩放；'fr' 表示弹性份额
  flexUnits?: EditorSplitFlexUnit[];
}

// 根据 sizes 推断每个子节点的尺寸语义。约定：>1 视为 px，<=1 视为 fr。
export function inferSplitFlexUnits(
  childCount: number,
  sizes: number[] | undefined,
): EditorSplitFlexUnit[] {
  return Array.from({ length: childCount }, (_, index) => {
    const size = sizes?.[index];
    if (typeof size === 'number' && size > 1) return 'px';
    return 'fr';
  });
}

export function createEditorLayout(
  node: LayoutNode,
  panelMap: Map<string, PanelDescriptor>,
  sessionId: string,
  windowId: string,
  path = '0',
): EditorLayoutNode {
  if (node.type === 'leaf') {
    const panel = panelMap.get(node.panel);
    if (node.panelType === 'simple') {
      return {
        kind: 'panel',
        panelId: `panel-${path}`,
        sessionId,
        windowId,
        panelType: 'simple',
        panelName: node.panel,
        title: panel?.titleKey ? i18nStore.t(panel.titleKey) : getPanelTitle(panel?.name ?? node.panel),
        titleKey: panel?.titleKey,
        src: panel?.entry,
      };
    }

    const groupId = `group-${path}`;
    const tab = createEditorTab(node, panelMap, sessionId, windowId, groupId, `${path}-0`);
    return {
      kind: 'group',
      groupId,
      sessionId,
      windowId,
      tabs: [tab],
      activeTabId: tab.tabId,
    };
  }

  if (node.type === 'tab') {
    const groupId = `group-${path}`;
    const tabs = node.children.map((child, index) => createEditorTab(
      child,
      panelMap,
      sessionId,
      windowId,
      groupId,
      `${path}-${index}`,
    ));
    return {
      kind: 'group',
      groupId,
      sessionId,
      windowId,
      tabs,
      activeTabId: tabs[node.activeIndex ?? 0]?.tabId ?? tabs[0]?.tabId ?? null,
    };
  }

  const children = node.children.map((child, index) => createEditorLayout(
    child,
    panelMap,
    sessionId,
    windowId,
    `${path}-${index}`,
  ));
  return {
    kind: 'split',
    direction: node.type === 'vsplit' ? 'column' : 'row',
    sizes: node.sizes,
    flexUnits: inferSplitFlexUnits(children.length, node.sizes),
    children,
  };
}

export function normalizeDropDescriptor(
  layout: EditorLayoutNode,
  sourceTabId: string,
  descriptor: DropDescriptor | null,
): DropDescriptor | null {
  if (!descriptor) return null;

  const source = findTab(layout, sourceTabId);
  if (!source) return null;
  if (source.tab.sessionId !== descriptor.targetSessionId) return null;
  if (source.tab.windowId !== descriptor.targetWindowId) return null;

  const target = findGroup(layout, descriptor.targetGroupId);
  if (!target) return null;

  if (descriptor.kind === 'insert-tab') {
    const targetIndex = target.tabs.findIndex((tab) => tab.tabId === descriptor.targetTabId);
    if (targetIndex < 0) return null;

    if (target.groupId === source.group.groupId) {
      const sourceIndex = source.group.tabs.findIndex((tab) => tab.tabId === sourceTabId);
      const insertIndex = descriptor.placement === 'before' ? targetIndex : targetIndex + 1;
      const adjustedIndex = sourceIndex < insertIndex ? insertIndex - 1 : insertIndex;
      if (adjustedIndex === sourceIndex) return null;
    }
  }

  if (
    descriptor.kind === 'split-group'
    && descriptor.targetGroupId === source.group.groupId
    && source.group.tabs.length === 1
  ) {
    return null;
  }

  return descriptor;
}

export function commitTabDrop(
  layout: EditorLayoutNode,
  sourceTabId: string,
  descriptor: DropDescriptor,
): EditorLayoutNode {
  const normalized = normalizeDropDescriptor(layout, sourceTabId, descriptor);
  if (!normalized) return layout;

  const extracted = extractTab(layout, sourceTabId);
  if (!extracted) return layout;

  const inserted = normalized.kind === 'insert-tab'
    ? insertTab(extracted.layout, extracted.tab, normalized)
    : splitGroup(extracted.layout, extracted.tab, normalized);

  return collapseLayout(inserted) ?? inserted;
}

export function serializeTabDragPayload(
  layout: EditorLayoutNode,
  source: {
    sessionId: string;
    sourceWindowId: string;
    sourceGroupId: string;
    sourceTabId: string;
  },
): TabDragPayload | null {
  const match = findTab(layout, source.sourceTabId);
  if (!match) return null;
  if (match.tab.sessionId !== source.sessionId) return null;
  if (match.tab.windowId !== source.sourceWindowId) return null;
  if (match.group.groupId !== source.sourceGroupId) return null;

  return {
    type: 'ce/tab-drag',
    sessionId: source.sessionId,
    sourceWindowId: source.sourceWindowId,
    sourceGroupId: source.sourceGroupId,
    sourceTabId: source.sourceTabId,
    tab: createDraggedTab(match.tab),
  };
}

export function commitCrossWindowTabDrop(
  layout: EditorLayoutNode,
  payload: TabDragPayload,
  descriptor: DropDescriptor,
): EditorLayoutNode {
  if (!isValidTabDragPayload(payload)) return layout;
  if (payload.sessionId !== descriptor.targetSessionId) return layout;
  if (payload.sourceWindowId === descriptor.targetWindowId) return layout;

  const targetGroup = findGroup(layout, descriptor.targetGroupId);
  if (!targetGroup) return layout;
  if (targetGroup.sessionId !== descriptor.targetSessionId) return layout;
  if (targetGroup.windowId !== descriptor.targetWindowId) return layout;

  if (descriptor.kind === 'insert-tab') {
    const targetTabExists = targetGroup.tabs.some((tab) => tab.tabId === descriptor.targetTabId);
    if (!targetTabExists) return layout;
  }

  const tab = createDroppedTab(payload.tab, descriptor.targetSessionId, descriptor.targetWindowId, descriptor.targetGroupId);
  const inserted = descriptor.kind === 'insert-tab'
    ? insertTab(layout, tab, descriptor)
    : splitGroup(layout, tab, descriptor);
  return collapseLayout(inserted) ?? inserted;
}

export function removeTabFromLayout(layout: EditorLayoutNode, sourceTabId: string): EditorLayoutNode {
  const extracted = extractTab(layout, sourceTabId);
  if (!extracted) return layout;
  return collapseLayout(extracted.layout) ?? extracted.layout;
}

export function dockFloatingPanel(
  layout: EditorLayoutNode,
  floating: {
    panelName: string;
    title: string;
    src?: string;
    titleKey?: string;
  },
  descriptor: DropDescriptor,
): EditorLayoutNode {
  const tab: EditorTab = {
    tabId: `tab-floating-${crypto.randomUUID()}`,
    sessionId: descriptor.targetSessionId,
    windowId: descriptor.targetWindowId,
    groupId: descriptor.targetGroupId,
    title: floating.title,
    titleKey: floating.titleKey,
    panelName: floating.panelName,
    panelType: 'iframe',
    src: floating.src,
    content: cloneLayoutNode({ type: 'leaf', panel: floating.panelName }),
  };

  const inserted = descriptor.kind === 'insert-tab'
    ? insertTab(layout, tab, descriptor)
    : splitGroup(layout, tab, descriptor);
  return collapseLayout(inserted) ?? inserted;
}

function createDraggedTab(tab: EditorTab): SerializedDraggedTab {
  return {
    title: tab.title,
    titleKey: tab.titleKey,
    panelName: tab.panelName,
    panelType: tab.panelType,
    src: tab.src,
    content: cloneLayoutNode(tab.content),
  };
}

function isValidTabDragPayload(payload: TabDragPayload): boolean {
  if (!isPlainRecord(payload) || !hasExactKeys(payload, [
    'type',
    'sessionId',
    'sourceWindowId',
    'sourceGroupId',
    'sourceTabId',
    'tab',
  ])) {
    return false;
  }

  return payload.type === 'ce/tab-drag'
    && typeof payload.sessionId === 'string'
    && typeof payload.sourceWindowId === 'string'
    && typeof payload.sourceGroupId === 'string'
    && typeof payload.sourceTabId === 'string'
    && isValidDraggedTab(payload.tab);
}

function isValidDraggedTab(tab: SerializedDraggedTab): boolean {
  if (!isPlainRecord(tab) || !hasAllowedKeys(tab, [
    'title',
    'titleKey',
    'panelName',
    'panelType',
    'src',
    'content',
  ]) || typeof tab.title !== 'string' || typeof tab.panelName !== 'string' || !('panelType' in tab)) {
    return false;
  }

  return (tab.titleKey === undefined || typeof tab.titleKey === 'string')
    && (tab.panelType === 'iframe' || tab.panelType === 'simple')
    && (tab.src === undefined || typeof tab.src === 'string')
    && isLayoutNode(tab.content);
}

function isLayoutNode(node: unknown): node is LayoutNode {
  if (!isPlainRecord(node) || typeof node.type !== 'string') return false;
  const candidate = node as Record<string, unknown>;
  if (candidate.type === 'leaf') {
    return hasAllowedKeys(candidate, ['type', 'panel', 'panelType'])
      && typeof candidate.panel === 'string'
      && (candidate.panelType === undefined || candidate.panelType === 'simple');
  }
  if (candidate.type === 'tab') {
    if (!hasAllowedKeys(candidate, ['type', 'children', 'activeIndex'])) return false;
    if (!Array.isArray(candidate.children) || candidate.children.length === 0) return false;
    if (!candidate.children.every(isLayoutNode)) return false;
    if (candidate.activeIndex === undefined) return true;
    const activeIndex = candidate.activeIndex;
    if (!Number.isInteger(activeIndex)) return false;
    return typeof activeIndex === 'number'
      && activeIndex >= 0
      && activeIndex < candidate.children.length;
  }
  if (candidate.type === 'hsplit' || candidate.type === 'vsplit') {
    if (!hasAllowedKeys(candidate, ['type', 'children', 'sizes'])) return false;
    if (!Array.isArray(candidate.children) || candidate.children.length === 0) return false;
    if (!candidate.children.every(isLayoutNode)) return false;
    if (candidate.sizes === undefined) return true;
    return Array.isArray(candidate.sizes)
      && candidate.sizes.length === candidate.children.length
      && candidate.sizes.every((size) => typeof size === 'number' && Number.isFinite(size));
  }
  return false;
}

function createDroppedTab(
  tab: SerializedDraggedTab,
  sessionId: string,
  windowId: string,
  groupId: string,
): EditorTab {
  return {
    tabId: `tab-dragged-${crypto.randomUUID()}`,
    sessionId,
    windowId,
    groupId,
    title: tab.title,
    titleKey: tab.titleKey,
    panelName: tab.panelName,
    panelType: tab.panelType,
    src: tab.src,
    content: cloneLayoutNode(tab.content),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(record: Record<string, unknown>, keys: string[]): boolean {
  const recordKeys = Object.keys(record).sort();
  const expectedKeys = [...keys].sort();
  return recordKeys.length === expectedKeys.length
    && recordKeys.every((key, index) => key === expectedKeys[index]);
}

function hasAllowedKeys(record: Record<string, unknown>, keys: string[]): boolean {
  const allowedKeys = new Set(keys);
  return Object.keys(record).every((key) => allowedKeys.has(key));
}

function cloneLayoutNode<T extends LayoutNode>(node: T): T {
  return JSON.parse(JSON.stringify(node)) as T;
}

function createEditorTab(
  content: LayoutNode,
  panelMap: Map<string, PanelDescriptor>,
  sessionId: string,
  windowId: string,
  groupId: string,
  key: string,
): EditorTab {
  const panelName = content.type === 'leaf' ? content.panel : `layout-${key}`;
  const descriptor = content.type === 'leaf' ? panelMap.get(content.panel) : undefined;
  return {
    tabId: `tab-${key}`,
    sessionId,
    windowId,
    groupId,
    title: getLayoutNodeTitle(content, panelMap),
    titleKey: descriptor?.titleKey,
    panelName,
    panelType: content.type === 'leaf' && content.panelType === 'simple' ? 'simple' : 'iframe',
    src: descriptor?.entry,
    content,
  };
}

function getLayoutNodeTitle(node: LayoutNode, panelMap: Map<string, PanelDescriptor>): string {
  if (node.type !== 'leaf') return 'Group';
  const panel = panelMap.get(node.panel);
  if (panel?.titleKey) return i18nStore.t(panel.titleKey);
  return panel?.title ?? getPanelTitle(panel?.name ?? node.panel);
}

export function mapLayoutTitles(
  node: EditorLayoutNode,
  translate: (titleKey: string | undefined, fallback: string) => string,
): EditorLayoutNode {
  if (node.kind === 'panel') {
    return { ...node, title: translate(node.titleKey, node.title) };
  }
  if (node.kind === 'group') {
    return {
      ...node,
      tabs: node.tabs.map((tab) => ({ ...tab, title: translate(tab.titleKey, tab.title) })),
    };
  }
  return { ...node, children: node.children.map((child) => mapLayoutTitles(child, translate)) };
}

function getPanelTitle(panelName: string): string {
  const shortName = panelName.split('/').pop() ?? panelName;
  const suffix = shortName.split('.').pop() ?? shortName;
  return suffix
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function findGroup(layout: EditorLayoutNode, groupId: string): EditorGroupNode | null {
  if (layout.kind === 'group') return layout.groupId === groupId ? layout : null;
  if (layout.kind === 'panel') return null;
  for (const child of layout.children) {
    const match = findGroup(child, groupId);
    if (match) return match;
  }
  return null;
}

function findTab(layout: EditorLayoutNode, tabId: string): { group: EditorGroupNode; tab: EditorTab } | null {
  if (layout.kind === 'group') {
    const tab = layout.tabs.find((item) => item.tabId === tabId);
    return tab ? { group: layout, tab } : null;
  }
  if (layout.kind === 'panel') return null;
  for (const child of layout.children) {
    const match = findTab(child, tabId);
    if (match) return match;
  }
  return null;
}

function extractTab(layout: EditorLayoutNode, sourceTabId: string): { layout: EditorLayoutNode; tab: EditorTab } | null {
  if (layout.kind === 'group') {
    const index = layout.tabs.findIndex((tab) => tab.tabId === sourceTabId);
    if (index < 0) return null;

    const tab = layout.tabs[index];
    const tabs = layout.tabs.filter((candidate) => candidate.tabId !== sourceTabId);
    const activeTabId = layout.activeTabId === sourceTabId
      ? tabs[Math.min(index, tabs.length - 1)]?.tabId ?? null
      : layout.activeTabId;

    return {
      tab,
      layout: {
        ...layout,
        tabs,
        activeTabId,
      },
    };
  }

  if (layout.kind === 'panel') return null;

  for (let index = 0; index < layout.children.length; index += 1) {
    const child = layout.children[index];
    const extracted = extractTab(child, sourceTabId);
    if (!extracted) continue;

    const children = [...layout.children];
    children[index] = extracted.layout;
    return {
      tab: extracted.tab,
      layout: { ...layout, children },
    };
  }

  return null;
}

function insertTab(
  layout: EditorLayoutNode,
  tab: EditorTab,
  descriptor: Extract<DropDescriptor, { kind: 'insert-tab' }>,
): EditorLayoutNode {
  if (layout.kind === 'group' && layout.groupId === descriptor.targetGroupId) {
    const targetIndex = layout.tabs.findIndex((item) => item.tabId === descriptor.targetTabId);
    if (targetIndex < 0) return layout;

    const insertIndex = descriptor.placement === 'before' ? targetIndex : targetIndex + 1;
    const movedTab = { ...tab, groupId: layout.groupId };
    const tabs = [...layout.tabs];
    tabs.splice(insertIndex, 0, movedTab);
    return { ...layout, tabs, activeTabId: movedTab.tabId };
  }

  if (layout.kind !== 'split') return layout;
  return { ...layout, children: layout.children.map((child) => insertTab(child, tab, descriptor)) };
}

function splitGroup(
  layout: EditorLayoutNode,
  tab: EditorTab,
  descriptor: Extract<DropDescriptor, { kind: 'split-group' }>,
): EditorLayoutNode {
  if (layout.kind === 'group' && layout.groupId === descriptor.targetGroupId) {
    const groupId = `group-split-${tab.tabId}`;
    const newGroup: EditorGroupNode = {
      kind: 'group',
      groupId,
      sessionId: tab.sessionId,
      windowId: tab.windowId,
      tabs: [{ ...tab, groupId }],
      activeTabId: tab.tabId,
    };
    const direction = descriptor.direction === 'top' || descriptor.direction === 'bottom' ? 'column' : 'row';
    const children = descriptor.direction === 'top' || descriptor.direction === 'left'
      ? [newGroup, layout]
      : [layout, newGroup];
    return { kind: 'split', direction, children };
  }

  if (layout.kind !== 'split') return layout;

  const children = layout.children.flatMap((child) => {
    const next = splitGroup(child, tab, descriptor);
    if (next.kind === 'split' && next.direction === layout.direction) {
      return next.children;
    }
    return [next];
  });
  return { ...layout, children };
}

function collapseLayout(layout: EditorLayoutNode): EditorLayoutNode | null {
  if (layout.kind === 'group') {
    return layout.tabs.length === 0 ? null : layout;
  }

  if (layout.kind === 'panel') return layout;

  const children = layout.children
    .map((child) => collapseLayout(child))
    .filter((child): child is EditorLayoutNode => child !== null);

  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return {
    ...layout,
    children,
    sizes: layout.sizes?.slice(0, children.length),
    flexUnits: layout.flexUnits?.slice(0, children.length),
  };
}
