import {
  commitCrossWindowTabDrop,
  commitTabDrop,
  normalizeDropDescriptor,
  serializeTabDragPayload,
  type DragSession,
  type DropDescriptor,
  type EditorLayoutNode,
  type TabDragPayload,
} from './tab-layout';
import { resolveDropDescriptor, type GroupDropTarget } from './tab-drop-resolver';

const TAB_DRAG_MIME = 'application/x-ce-tab-drag';
const TAB_DRAG_TEXT_PREFIX = 'ce-tab-drag:';

export class TabDragController {
  private dragSession: DragSession | null = null;
  private dragShield: HTMLElement | null = null;
  private dragging = false;
  private nativeDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private moveHandler = (event: PointerEvent) => this.handlePointerMove(event);
  private upHandler = (event: PointerEvent) => this.handlePointerUp(event);
  private dragStartHandler = (event: DragEvent) => this.handleDragStart(event);
  private dragOverHandler = (event: DragEvent) => this.handleDragOver(event);
  private dropHandler = (event: DragEvent) => this.handleDrop(event);
  private dragEndHandler = () => this.handleDragEnd();

  constructor(
    private root: HTMLElement,
    private options: {
      getLayout: () => EditorLayoutNode | null;
      commitLayout: (layout: EditorLayoutNode) => void;
      dockFloatingPanel?: (panelInstanceId: string, descriptor: DropDescriptor) => void;
      broadcastCloseSource?: (payload: {
        sessionId: string;
        sourceWindowId: string;
        sourceGroupId: string;
        sourceTabId: string;
      }) => void;
    },
  ) {}

  bind() {
    this.root.addEventListener('pointerdown', this.handlePointerDown as EventListener);
    this.root.addEventListener('dragstart', this.dragStartHandler as EventListener);
    this.root.addEventListener('dragover', this.dragOverHandler as EventListener);
    this.root.addEventListener('drop', this.dropHandler as EventListener);
    this.root.addEventListener('dragend', this.dragEndHandler as EventListener);
  }

  destroy() {
    this.root.removeEventListener('pointerdown', this.handlePointerDown as EventListener);
    this.root.removeEventListener('dragstart', this.dragStartHandler as EventListener);
    this.root.removeEventListener('dragover', this.dragOverHandler as EventListener);
    this.root.removeEventListener('drop', this.dropHandler as EventListener);
    this.root.removeEventListener('dragend', this.dragEndHandler as EventListener);
    this.removeDocumentListeners();
    this.removeDragShield();
    this.clearPreview();
  }

  private handlePointerDown = (event: PointerEvent) => {
    const path = event.composedPath();
    const tabItem = path.find((node) => node instanceof HTMLElement && node.classList.contains('tab-item')) as HTMLElement | undefined;
    const group = path.find((node) => node instanceof HTMLElement && node.tagName.toLowerCase() === 'ce-panel-group') as HTMLElement | undefined;
    if (!tabItem || !group) return;

    this.dragSession = {
      dragId: crypto.randomUUID(),
      sourceSessionId: group.dataset.sessionId || '',
      sourceWindowId: group.dataset.windowId || '',
      sourceGroupId: group.dataset.groupId || '',
      sourceTabId: tabItem.dataset.tabId || '',
      currentDescriptor: null,
      forbidden: false,
    };
    this.dragging = false;
    this.dragStartX = event.clientX;
    this.dragStartY = event.clientY;

    this.addDocumentListeners();
  };

  private handleDragStart(event: DragEvent): void {
    const path = event.composedPath();
    const tabItem = path.find((node) => node instanceof HTMLElement && node.classList.contains('tab-item')) as HTMLElement | undefined;
    const group = path.find((node) => node instanceof HTMLElement && node.tagName.toLowerCase() === 'ce-panel-group') as HTMLElement | undefined;
    if (!tabItem || !group || !event.dataTransfer) return;

    const layout = this.options.getLayout();
    if (!layout) {
      event.preventDefault();
      return;
    }

    const payload = serializeTabDragPayload(layout, {
      sessionId: group.dataset.sessionId || '',
      sourceWindowId: group.dataset.windowId || '',
      sourceGroupId: group.dataset.groupId || '',
      sourceTabId: tabItem.dataset.tabId || '',
    });
    if (!payload) {
      event.preventDefault();
      return;
    }

    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(TAB_DRAG_MIME, JSON.stringify(payload));
    event.dataTransfer.setData('text/plain', `${TAB_DRAG_TEXT_PREFIX}${JSON.stringify(payload)}`);
    this.nativeDragging = true;
    this.dragSession = null;
    this.dragging = false;
    this.removeDragShield();
    this.clearPreview();
  }

  private handleDragOver(event: DragEvent): void {
    const payload = this.readTabDragPayload(event.dataTransfer);
    if (!payload) return;

    const targetGroup = this.findTargetGroup(event.clientX, event.clientY);
    if (
      !targetGroup
      || payload.sessionId !== targetGroup.sessionId
      || payload.sourceWindowId === targetGroup.windowId
    ) {
      this.root.setAttribute('data-tab-drag-forbidden', '');
      this.clearPreview();
      return;
    }

    const descriptor = resolveDropDescriptor({
      sourceSessionId: payload.sessionId,
      sourceGroupId: payload.sourceGroupId,
      sourceTabId: payload.sourceTabId,
      target: targetGroup,
      clientX: event.clientX,
      clientY: event.clientY,
    });
    if (!descriptor) {
      this.root.setAttribute('data-tab-drag-forbidden', '');
      this.clearPreview();
      return;
    }

    event.preventDefault();
    const dataTransfer = event.dataTransfer;
    if (dataTransfer) {
      dataTransfer.dropEffect = 'move';
    }
    this.root.removeAttribute('data-tab-drag-forbidden');
    this.applyPreview(descriptor);
  }

  private handleDrop(event: DragEvent): void {
    const finishNativeDrop = () => {
      this.nativeDragging = false;
      this.root.removeAttribute('data-tab-drag-forbidden');
      this.clearPreview();
    };

    const payload = this.readTabDragPayload(event.dataTransfer);
    const layout = this.options.getLayout();
    if (!payload || !layout) {
      finishNativeDrop();
      return;
    }

    const targetGroup = this.findTargetGroup(event.clientX, event.clientY);
    if (
      !targetGroup
      || payload.sessionId !== targetGroup.sessionId
      || payload.sourceWindowId === targetGroup.windowId
    ) {
      this.root.setAttribute('data-tab-drag-forbidden', '');
      finishNativeDrop();
      return;
    }

    const descriptor = resolveDropDescriptor({
      sourceSessionId: payload.sessionId,
      sourceGroupId: payload.sourceGroupId,
      sourceTabId: payload.sourceTabId,
      target: targetGroup,
      clientX: event.clientX,
      clientY: event.clientY,
    });
    if (!descriptor) {
      this.root.setAttribute('data-tab-drag-forbidden', '');
      finishNativeDrop();
      return;
    }

    event.preventDefault();
    const next = commitCrossWindowTabDrop(layout, payload, descriptor);
    if (next !== layout) {
      this.options.commitLayout(next);
      this.options.broadcastCloseSource?.({
        sessionId: payload.sessionId,
        sourceWindowId: payload.sourceWindowId,
        sourceGroupId: payload.sourceGroupId,
        sourceTabId: payload.sourceTabId,
      });
      this.root.removeAttribute('data-tab-drag-forbidden');
    }
    finishNativeDrop();
  }

  private handleDragEnd(): void {
    if (!this.nativeDragging) return;
    this.nativeDragging = false;
    this.root.removeAttribute('data-tab-drag-forbidden');
    this.clearPreview();
  }

  private handlePointerMove(event: PointerEvent) {
    if (!this.dragSession) return;
    if (!this.dragging) {
      const deltaX = event.clientX - this.dragStartX;
      const deltaY = event.clientY - this.dragStartY;
      if (Math.hypot(deltaX, deltaY) < 4) return;
      this.dragging = true;
      this.addDragShield();
    }
    event.preventDefault();

    const targetGroup = this.findTargetGroup(event.clientX, event.clientY);
    if (!targetGroup) {
      this.dragSession.currentDescriptor = null;
      this.dragSession.forbidden = true;
      this.root.setAttribute('data-tab-drag-forbidden', '');
      this.clearPreview();
      return;
    }

    const floatingPanelInstanceId = getFloatingPanelInstanceId(this.dragSession.sourceGroupId);
    const descriptor = resolveDropDescriptor({
      sourceSessionId: floatingPanelInstanceId ? targetGroup.sessionId : this.dragSession.sourceSessionId,
      sourceGroupId: this.dragSession.sourceGroupId,
      sourceTabId: this.dragSession.sourceTabId,
      target: targetGroup,
      clientX: event.clientX,
      clientY: event.clientY,
    });

    const layout = this.options.getLayout();
    const normalized = floatingPanelInstanceId
      ? descriptor
      : layout
        ? normalizeDropDescriptor(layout, this.dragSession.sourceTabId, descriptor)
        : descriptor;

    this.dragSession.currentDescriptor = normalized;
    this.dragSession.forbidden = !normalized;
    if (normalized) {
      this.root.removeAttribute('data-tab-drag-forbidden');
      this.applyPreview(normalized);
    } else {
      this.root.setAttribute('data-tab-drag-forbidden', '');
      this.clearPreview();
    }
  }

  private handlePointerUp(_event: PointerEvent) {
    if (!this.dragSession) return;

    const layout = this.options.getLayout();
    const floatingPanelInstanceId = getFloatingPanelInstanceId(this.dragSession.sourceGroupId);
    if (
      this.dragging
      && layout
      && this.dragSession.currentDescriptor
      && !this.dragSession.forbidden
      && floatingPanelInstanceId
    ) {
      this.options.dockFloatingPanel?.(floatingPanelInstanceId, this.dragSession.currentDescriptor);
    } else if (this.dragging && layout && this.dragSession.currentDescriptor && !this.dragSession.forbidden) {
      const next = commitTabDrop(layout, this.dragSession.sourceTabId, this.dragSession.currentDescriptor);
      this.options.commitLayout(next);
    }

    this.dragSession = null;
    this.dragging = false;
    this.clearPreview();
    this.removeDragShield();
    this.removeDocumentListeners();
  }

  private readTabDragPayload(dataTransfer: DataTransfer | null): TabDragPayload | null {
    if (!dataTransfer) return null;

    const mimePayload = dataTransfer.getData(TAB_DRAG_MIME);
    const textPayload = dataTransfer.getData('text/plain');
    const raw = mimePayload || (
      textPayload.startsWith(TAB_DRAG_TEXT_PREFIX)
        ? textPayload.slice(TAB_DRAG_TEXT_PREFIX.length)
        : ''
    );
    if (!raw) return null;

    try {
      const payload = JSON.parse(raw) as Partial<TabDragPayload>;
      if (
        payload.type !== 'ce/tab-drag'
        || typeof payload.sessionId !== 'string'
        || typeof payload.sourceWindowId !== 'string'
        || typeof payload.sourceGroupId !== 'string'
        || typeof payload.sourceTabId !== 'string'
        || !payload.tab
        || typeof payload.tab.title !== 'string'
        || typeof payload.tab.panelName !== 'string'
      ) {
        return null;
      }
      return payload as TabDragPayload;
    } catch {
      return null;
    }
  }

  private findTargetGroup(clientX: number, clientY: number): GroupDropTarget | null {
    const groups = Array.from(this.root.querySelectorAll('ce-panel-group')) as HTMLElement[];
    for (const group of groups) {
      const tabBar = group.shadowRoot?.querySelector('.tab-bar') as HTMLElement | null;
      const content = group.shadowRoot?.querySelector('.content') as HTMLElement | null;
      if (!tabBar || !content) continue;

      const tabs = Array.from(group.shadowRoot?.querySelectorAll('.tab-item') ?? []).map((item) => {
        const tab = item as HTMLElement;
        const rect = tab.getBoundingClientRect();
        return { tabId: tab.dataset.tabId || '', left: rect.left, right: rect.right };
      });

      const target: GroupDropTarget = {
        sessionId: group.dataset.sessionId || '',
        windowId: group.dataset.windowId || '',
        groupId: group.dataset.groupId || '',
        tabStripRect: tabBar.getBoundingClientRect(),
        contentRect: content.getBoundingClientRect(),
        tabs,
      };

      const withinTabBar = contains(target.tabStripRect, clientX, clientY);
      const withinContent = contains(target.contentRect, clientX, clientY);
      if (withinTabBar || withinContent) return target;
    }

    return null;
  }

  private applyPreview(descriptor: NonNullable<DragSession['currentDescriptor']>) {
    this.clearPreview();
    const group = this.root.querySelector(`ce-panel-group[data-group-id="${cssEscape(descriptor.targetGroupId)}"]`) as HTMLElement | null;
    if (!group) return;

    if (descriptor.kind === 'insert-tab') {
      group.setAttribute('data-drop-target-tab-id', descriptor.targetTabId);
      group.setAttribute('data-drop-placement', descriptor.placement);
      return;
    }

    group.setAttribute('data-drop-edge', descriptor.direction);
  }

  private clearPreview() {
    this.root.querySelectorAll('ce-panel-group').forEach((group) => {
      group.removeAttribute('data-drop-target-tab-id');
      group.removeAttribute('data-drop-placement');
      group.removeAttribute('data-drop-edge');
    });
  }

  private addDocumentListeners() {
    document.addEventListener('pointermove', this.moveHandler);
    document.addEventListener('pointerup', this.upHandler);
    document.addEventListener('pointercancel', this.upHandler);
  }

  private removeDocumentListeners() {
    document.removeEventListener('pointermove', this.moveHandler);
    document.removeEventListener('pointerup', this.upHandler);
    document.removeEventListener('pointercancel', this.upHandler);
  }

  private addDragShield() {
    this.removeDragShield();

    const shield = this.root.ownerDocument.createElement('div');
    shield.setAttribute('data-ce-tab-drag-shield', '');
    Object.assign(shield.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483647',
      cursor: 'grabbing',
      background: 'transparent',
      userSelect: 'none',
      touchAction: 'none',
    });
    this.root.ownerDocument.body.appendChild(shield);
    this.dragShield = shield;
  }

  private removeDragShield() {
    this.dragShield?.remove();
    this.dragShield = null;
  }
}

function contains(rect: DOMRect | { left: number; right: number; top: number; bottom: number }, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function cssEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function getFloatingPanelInstanceId(groupId: string): string | null {
  const match = groupId.match(/^floating-(.+)$/);
  return match?.[1] ?? null;
}
