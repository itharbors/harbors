import { EditorTransport, getKitFromURL, getSessionIdFromURL, splitRuntimeSessionId } from '../core/transport';
import type { BootstrapInfo, I18nChangeEvent, I18nVisibleSnapshot, LayoutNode } from '../core/session';
import { ClientSession } from '../core/session';
import { generateUUID, getStoredSessionId } from '../core/storage';
import { I18nClient } from '../i18n/client';
import { i18nStore } from '../i18n/store';
import '../layout/split-pane';
import '../layout/divider';
import '../layout/panel';
import '../layout/panel-group';
import './floating-panel-layer';
import { bindResizableSplitPanes, isSplitInResizePath } from '../layout/resizable-split';
import { TabDragController } from '../layout/tab-drag-controller';
import {
  createEditorLayout,
  dockFloatingPanel as dockFloatingPanelIntoLayout,
  removeTabFromLayout,
  type EditorGroupNode,
  type EditorLayoutNode,
  type EditorPanelNode,
  type EditorSplitNode,
  type EditorSplitFlexUnit,
  inferSplitFlexUnits,
  mapLayoutTitles,
} from '../layout/tab-layout';
import { createWindowLayoutStorage } from '../layout/storage';
import { applyThemeTokensToElement, DEFAULT_THEME_TOKENS, type ThemeTokens } from '../styles/theme';
import { bindThemeToIframe } from '../styles/iframe-theme';
import { getMenuModeFromURL, mountMenuRuntime, type MenuRuntime, type MenuRuntimeInput } from '../menu/runtime';
import type { FloatingPanelState } from './floating-panel-layer';

type PendingWindowOpen = {
  panelId: string; panelName: string; sessionId: string; token: number; nonce: string;
  popup: Window; timer: number; poll: number; windowGroupId?: string; cancelled: boolean; cleaned: boolean;
};

export class EditorApp extends HTMLElement {
  private session: ClientSession | null = null;
  private transport: EditorTransport | null = null;
  private lastSSEEvent: string = '—';
  private workspacePath: string = '—';
  private bootstrap: BootstrapInfo | null = null;
  private panelMap = new Map<string, BootstrapInfo['panels'][number]>();
  private readonly panelRevisions = new Map<string, number>();
  private readonly panelAvailability = new Map<string, 'available' | 'unavailable'>();
  private layout: EditorLayoutNode | null = null;
  private dragController: TabDragController | null = null;
  private hostThemeTokens: ThemeTokens = DEFAULT_THEME_TOKENS;
  private initToken = 0;
  private initializationFailed = false;
  private i18nClient: I18nClient | null = null;
  private menuRuntime: MenuRuntime | null = null;
  private renderedWindow: BootstrapInfo['windows'][number] | null = null;
  private floatingPanels: FloatingPanelState[] = [];
  private hiddenFloatingIds = new Set<string>();
  private channel: BroadcastChannel | null = null;
  private readonly iframeThemeBindings = new Map<HTMLIFrameElement, () => void>();
  private readonly pendingPanelRequests = new Map<string, { source: Window; timer: number }>();
  private readonly pendingWindowOpens = new Map<string, PendingWindowOpen>();
  private readonly layoutStorage = createWindowLayoutStorage({
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
  });
  private defaultLayoutSignature: string | null = null;
  private readonly collapsedColumnGroups = new Set<string>();
  private readonly expandedRowFlex = new WeakMap<HTMLElement, string[]>();
  private suppressCollapseClick = false;
  private handlePanelChange = (event: Event) => this.handlePanelGroupChange(event);
  private handleColumnCollapse = (event: Event) => {
    if (event.target instanceof HTMLElement && this.collapsePanelColumn(event.target, true)) {
      this.suppressCollapseClick = true;
      bindResizableSplitPanes(this);
    }
  };
  private clearCollapseClickSuppression = () => {
    this.suppressCollapseClick = false;
  };
  // 点按结束时收起列，浏览器随后可能把 click 派发给刚露出的控件。
  private handleClickAfterCollapse = (event: MouseEvent) => {
    if (!this.suppressCollapseClick || event.detail === 0) return;

    this.clearCollapseClickSuppression();
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  private handleDividerDragStart = () => this.broadcastLayoutResizeState(true);
  private handleDividerDragEnd = (event: Event) => {
    this.broadcastLayoutResizeState(false);
    if ((event as CustomEvent<{ moved: boolean }>).detail?.moved) {
      this.persistRenderedLayoutSize(event.target instanceof HTMLElement ? event.target : null);
    }
  };
  private handleWindowMessage = (event: MessageEvent) => this.handlePanelWindowMessage(event);
  private handleChannelMessageEvent = (event: MessageEvent) => this.handleChannelMessage(event.data);
  private handleSecondaryPageHide = () => this.cleanupSecondaryWindowGroup(true);
  private handleSecondaryBeforeUnload = () => this.cleanupSecondaryWindowGroup(true);
  private handleFloatingPanelClose = (event: Event) => this.handleFloatingPanelCloseAction(event);
  private handleFloatingPanelOpenWindow = (event: Event) => { void this.openFloatingPanelWindow(getPanelInstanceIdFromEvent(event)); };
  private handleFloatingPanelGeometry = (event: Event) => this.updateFloatingPanelGeometry(event);
  private handleLocalPanelOpen = (event: Event) => {
    const panelName = (event as CustomEvent<{ panelName?: unknown }>).detail?.panelName;
    if (this.windowGroupKind !== 'main' || typeof panelName !== 'string' || !this.panelMap.has(panelName)
      || this.panelAvailability.get(panelName) === 'unavailable') { event.preventDefault(); return; }
    const id = `local:${panelName}`;
    const existing = this.floatingPanels.find((panel) => panel.id === id && panel.localOnly);
    if (existing) return;
    const panel = this.createFloatingPanelState({ id, panelName, state: 'open', index: this.floatingPanels.length });
    if (!panel) { event.preventDefault(); return; }
    panel.localOnly = true;
    this.floatingPanels = [...this.floatingPanels, panel];
    this.syncFloatingPanelLayer();
  };
  private secondaryWindowCleanupSent = false;
  // 窗口缩放期间频繁触发 panel iframe 的重新布局，会让 WebGL/Canvas 面板反复 setSize 导致闪烁。
  // 我们用 debounce：第一次 resize 广播 layout-resize-start，停止 resize 一段时间后再广播 layout-resize-end。
  private windowResizing = false;
  private windowResizeEndTimer: number | null = null;
  private static readonly WINDOW_RESIZE_END_DELAY_MS = 150;
  private handleWindowResize = () => this.handleWindowResizeTick();

  connectedCallback() {
    this.style.display = 'flex';
    this.style.flexDirection = 'column';
    this.style.width = '100%';
    this.style.height = '100%';
    this.style.minWidth = '0';
    this.style.minHeight = '0';
    this.style.overflow = 'hidden';
    this.style.position = 'relative';

    const sessionReference = getSessionIdFromURL() || getStoredSessionId();
    if (!sessionReference) {
      this.innerHTML = '<div role="alert">无法打开工作台：缺少已验证的 Session。</div>';
      return;
    }

    const parsed = this.windowGroupKind === 'secondary' ? splitRuntimeSessionId(sessionReference) : { sessionId: sessionReference, kit: undefined };
    const sessionId = parsed.sessionId;
    const kit = parsed.kit || getKitFromURL() || undefined;
    this.session = new ClientSession(sessionId);
    this.transport = new EditorTransport(this.session, { kit });
    this.i18nClient = new I18nClient(kit ? `${sessionId}::${kit}` : sessionId);
    this.channel = createSessionBroadcastChannel(sessionId);
    this.channel?.addEventListener('message', this.handleChannelMessageEvent);
    this.dragController = new TabDragController(this, {
      getLayout: () => this.layout,
      commitLayout: (layout) => {
        this.layout = layout;
        this.saveCachedLayout();
        this.render();
      },
      dockFloatingPanel: (panelInstanceId, descriptor) => this.dockFloatingPanel(panelInstanceId, descriptor),
      broadcastCloseSource: (payload) => {
        this.channel?.postMessage({
          type: 'ce-tab-drag-close-source',
          payload,
        });
      },
    });
    this.dragController.bind();
    this.addEventListener('ce-panel-change', this.handlePanelChange);
    this.addEventListener('ce-panel-column-collapse', this.handleColumnCollapse);
    this.addEventListener('click', this.handleClickAfterCollapse, true);
    this.ownerDocument.addEventListener('pointerdown', this.clearCollapseClickSuppression, true);
    this.ownerDocument.addEventListener('touchstart', this.clearCollapseClickSuppression, { capture: true, passive: true });
    this.addEventListener('ce-divider-drag-start', this.handleDividerDragStart);
    this.addEventListener('ce-divider-drag-end', this.handleDividerDragEnd);
    this.addEventListener('ce-floating-panel-close', this.handleFloatingPanelClose);
    this.addEventListener('ce-floating-panel-open-window', this.handleFloatingPanelOpenWindow);
    this.addEventListener('ce-floating-panel-geometry', this.handleFloatingPanelGeometry);
    this.addEventListener('ce-local-panel-open', this.handleLocalPanelOpen);
    window.addEventListener('resize', this.handleWindowResize);
    window.addEventListener('message', this.handleWindowMessage);
    if (this.windowGroupKind === 'secondary') {
      window.addEventListener('pagehide', this.handleSecondaryPageHide);
      window.addEventListener('beforeunload', this.handleSecondaryBeforeUnload);
    }

    this.initializationFailed = false;
    this.render();
    this.initToken += 1;
    void this.init(this.initToken);
  }

  disconnectedCallback() {
    this.initToken += 1;
    this.cancelPendingWindowOpens();
    this.clearPendingPanelRequests();
    this.clearIframeThemeBindings();
    this.clearPanelModalState();
    this.transport?.disconnectSSE();
    this.channel?.removeEventListener('message', this.handleChannelMessageEvent);
    this.channel?.close();
    this.channel = null;
    this.menuRuntime?.dispose();
    this.menuRuntime = null;
    this.i18nClient = null;
    this.removeEventListener('ce-panel-change', this.handlePanelChange);
    this.removeEventListener('ce-panel-column-collapse', this.handleColumnCollapse);
    this.removeEventListener('click', this.handleClickAfterCollapse, true);
    this.ownerDocument.removeEventListener('pointerdown', this.clearCollapseClickSuppression, true);
    this.ownerDocument.removeEventListener('touchstart', this.clearCollapseClickSuppression, true);
    this.clearCollapseClickSuppression();
    this.removeEventListener('ce-divider-drag-start', this.handleDividerDragStart);
    this.removeEventListener('ce-divider-drag-end', this.handleDividerDragEnd);
    this.removeEventListener('ce-floating-panel-close', this.handleFloatingPanelClose);
    this.removeEventListener('ce-floating-panel-open-window', this.handleFloatingPanelOpenWindow);
    this.removeEventListener('ce-floating-panel-geometry', this.handleFloatingPanelGeometry);
    this.removeEventListener('ce-local-panel-open', this.handleLocalPanelOpen);
    this.floatingPanels = this.floatingPanels.filter((panel) => !panel.localOnly);
    window.removeEventListener('resize', this.handleWindowResize);
    window.removeEventListener('message', this.handleWindowMessage);
    window.removeEventListener('pagehide', this.handleSecondaryPageHide);
    window.removeEventListener('beforeunload', this.handleSecondaryBeforeUnload);
    this.cleanupSecondaryWindowGroup(false);
    if (this.windowResizeEndTimer !== null) {
      window.clearTimeout(this.windowResizeEndTimer);
      this.windowResizeEndTimer = null;
    }
    if (this.windowResizing) {
      this.windowResizing = false;
      this.broadcastLayoutResizeState(false);
    }
    this.dragController?.destroy();
    this.dragController = null;
  }

  private handleWindowResizeTick(): void {
    if (!this.windowResizing) {
      this.windowResizing = true;
      this.broadcastLayoutResizeState(true);
    }
    if (this.windowResizeEndTimer !== null) {
      window.clearTimeout(this.windowResizeEndTimer);
    }
    this.windowResizeEndTimer = window.setTimeout(() => {
      this.windowResizeEndTimer = null;
      this.windowResizing = false;
      this.broadcastLayoutResizeState(false);
    }, EditorApp.WINDOW_RESIZE_END_DELAY_MS);
  }

  setLocale(locale: string): Promise<I18nVisibleSnapshot> {
    if (!this.i18nClient) {
      throw new Error('EditorApp is not connected');
    }
    return this.i18nClient.setLocale(locale);
  }

  private async init(token: number) {
    this.cancelPendingWindowOpens();
    this.clearPendingPanelRequests();
    try {
      const info = await this.transport!.fetchSessionInfo();
      if (token !== this.initToken || !this.isConnected) return;
      this.workspacePath = info.workspacePath || '（未设置）';
      const bootstrap = await this.transport!.fetchBootstrap();
      if (token !== this.initToken || !this.isConnected) return;
      this.bootstrap = bootstrap;
      this.i18nClient = new I18nClient(bootstrap.sessionId);
      i18nStore.hydrate(bootstrap.i18n ?? createEmptyI18nSnapshot());
      this.mountMenuRuntime({
        sessionId: bootstrap.sessionId,
        menuMode: getMenuModeFromURL(),
        menuTree: bootstrap.menuTree,
        applicationMenuTree: bootstrap.applicationMenuTree ?? [],
        kitMenuTree: bootstrap.kitMenuTree ?? [],
        kitMenuRoot: bootstrap.kitMenuRoot ?? null,
      });
      this.hostThemeTokens = {
        ...DEFAULT_THEME_TOKENS,
        ...(bootstrap.theme ?? {}),
      };
      this.panelMap = new Map(bootstrap.panels.map((panel) => [panel.name, panel]));
      this.panelRevisions.clear();
      this.panelAvailability.clear();
      bootstrap.panels.forEach((panel) => this.panelAvailability.set(panel.name, 'available'));
      this.hiddenFloatingIds = readHiddenFloatingIds(bootstrap);
      this.floatingPanels = this.createBootstrapFloatingPanels(bootstrap);
      this.layout = null;
      this.defaultLayoutSignature = null;
      this.renderedWindow = null;
      this.render();
    } catch (err) {
      if (token !== this.initToken || !this.isConnected) return;
      this.initializationFailed = true;
      this.render();
      console.error('Failed to fetch session:', err);
      return;
    }

    if (token !== this.initToken || !this.isConnected) return;
    this.transport!.connectSSE((event) => {
      this.lastSSEEvent = JSON.stringify(event);
      if (event.type === 'connected') {
        this.session!.sseActive = true;
      }
      if (event.type === 'panel-dispatch') {
        this.dispatchPanelEvent(event);
      }
      if ((event as { type?: string }).type === 'panel-availability-changed') {
        this.handlePanelAvailabilityChanged(event);
      }
      if (event.type === 'locale-changed' || event.type === 'messages-changed') {
        this.handleI18nEvent(event);
      }
      if (event.type === 'menu-changed') {
        this.handleMenuEvent(event);
      }
      if (event.type === 'layout-changed') {
        this.handleLayoutChanged(event.window as BootstrapInfo['windows'][number]);
      }
    });
  }

  private render() {
    this.clearPanelModalState();
    const content = this.initializationFailed
      ? this.renderLoadingLayout('工作台加载失败。', true)
      : this.layout
        ? this.renderEditorLayoutNode(this.layout)
        : this.bootstrap
          ? this.renderBootstrapLayout(this.bootstrap)
          : this.renderLoadingLayout();
    const floatingLayer = this.windowGroupKind === 'main'
      ? `<floating-panel-layer ${this.bootstrap ? 'style="top:32px"' : ''} data-state="${escapeAttr(JSON.stringify(this.floatingPanels))}"></floating-panel-layer>`
      : '';
    this.innerHTML = `
      ${this.bootstrap ? '<div data-web-menu></div>' : ''}
      <ce-split-pane direction="column" style="
        width:100%;
        height:100%;
        flex:1 1 auto;
        min-width:0;
        min-height:0;
        box-sizing:border-box;
        padding:var(--ce-workbench-padding, 0);
        --split-gap:var(--ce-workbench-gap, 0);
        background:var(--ce-workbench-bg, var(--ce-surface, #1a1a1a));
      ">
        ${content}
      </ce-split-pane>
      ${floatingLayer}
    `;
    const outer = this.querySelector('ce-split-pane');
    if (outer instanceof HTMLElement) {
      applyThemeTokensToElement(outer, this.hostThemeTokens);
    }
    const menuContainer = this.querySelector<HTMLElement>('[data-web-menu]');
    if (menuContainer) {
      applyThemeTokensToElement(menuContainer, this.hostThemeTokens);
      this.menuRuntime?.attach(menuContainer);
    }
    this.querySelector<HTMLButtonElement>('button[data-retry-initialization]')?.addEventListener('click', () => {
      this.initializationFailed = false;
      this.bootstrap = null;
      this.layout = null;
      this.render();
      void this.init(++this.initToken);
    }, { once: true });
    for (const groupId of this.collapsedColumnGroups) {
      const group = Array.from(this.querySelectorAll<HTMLElement>('ce-panel-group[data-group-id]'))
        .find((candidate) => candidate.dataset.groupId === groupId && !candidate.closest('ce-panel'));
      if (!group || !this.collapsePanelColumn(group)) this.collapsedColumnGroups.delete(groupId);
    }
    bindResizableSplitPanes(this);
    queueMicrotask(() => {
      if (this.isConnected) {
        this.syncIframeThemes();
      }
    });
  }

  private clearPanelModalState(): void {
    this.querySelectorAll('ce-panel[modal-open]').forEach((panel) => panel.removeAttribute('modal-open'));
  }

  private get windowGroupKind(): 'main' | 'secondary' {
    return this.getAttribute('window-group-kind') === 'secondary' ? 'secondary' : 'main';
  }

  private renderBootstrapLayout(bootstrap: BootstrapInfo): string {
    const windowGroup = this.resolveWindowGroup(bootstrap);
    if (!windowGroup || !this.session) {
      return this.renderLoadingLayout('No windows in kit layout');
    }

    this.renderedWindow = windowGroup;
    const defaultLayout = createEditorLayout(windowGroup.layout, this.panelMap, this.session.sessionId, windowGroup.id);
    this.defaultLayoutSignature = createDefaultLayoutSignature(windowGroup.layout, this.panelMap);
    this.layout = this.loadCachedLayout(bootstrap.kitName ?? 'unknown-kit', windowGroup.id, this.defaultLayoutSignature)
      ?? defaultLayout;
    return this.renderEditorLayoutNode(this.layout);
  }

  private handleLayoutChanged(windowDescriptor: BootstrapInfo['windows'][number]): void {
    if (this.windowGroupKind !== 'main') return;
    if (!this.session || !this.bootstrap) return;

    this.renderedWindow = windowDescriptor;
    this.collapsedColumnGroups.clear();
    this.defaultLayoutSignature = createDefaultLayoutSignature(windowDescriptor.layout, this.panelMap);
    this.layout = createEditorLayout(
      windowDescriptor.layout,
      this.panelMap,
      this.session.sessionId,
      windowDescriptor.id,
    );
    this.render();
    this.saveCachedLayout();
  }

  private resolveWindowGroup(bootstrap: BootstrapInfo): BootstrapInfo['windows'][number] | undefined {
    const params = new URLSearchParams(window.location.search);
    const windowGroupId = params.get('windowGroupId');
    if (windowGroupId) {
      return bootstrap.windows.find((windowGroup) => windowGroup.id === windowGroupId);
    }

    if (this.windowGroupKind === 'secondary') {
      return bootstrap.windows.find((windowGroup) => windowGroup.kind === 'secondary');
    }

    return bootstrap.windows.find((windowGroup) => windowGroup.kind === 'main') ?? bootstrap.windows[0];
  }

  private handlePanelGroupChange(event: Event): void {
    if (!this.layout) return;
    const group = event.target as HTMLElement | null;
    if (!group || group.tagName.toLowerCase() !== 'ce-panel-group') return;

    const activePanel = group.querySelector(':scope > ce-panel[active]') as HTMLElement | null;
    const groupId = group.dataset.groupId;
    const tabId = activePanel?.dataset.tabId;
    if (!groupId || !tabId) return;

    this.clearPanelModalState();
    this.layout = setActiveTab(this.layout, groupId, tabId);
    this.saveCachedLayout();
  }

  private collapsePanelColumn(group: HTMLElement, focus = false): boolean {
    const groupId = group.dataset.groupId;
    if (group.tagName !== 'CE-PANEL-GROUP' || !groupId) return false;

    // Use the outermost horizontal split so stacked groups fold as one column.
    let branch = group;
    let column: HTMLElement | null = null;
    while (branch.parentElement?.tagName === 'CE-SPLIT-PANE') {
      const split = branch.parentElement;
      if (split.getAttribute('direction') === 'row') column = branch;
      branch = split;
    }
    if (branch.parentElement !== this || !column || column.hidden) return false;

    const row = column.parentElement!;
    const columns = layoutChildren(row);
    if (columns.filter((child) => !child.hidden).length < 2) return false;

    const side = column === columns[0] ? 'left' : column === columns.at(-1) ? 'right' : null;
    if (!side) return false;

    if (columns.every((child) => !child.hidden)) {
      this.expandedRowFlex.set(row, columns.map((child) => child.style.flex));
    }
    const sibling = side === 'left' ? column.nextElementSibling : column.previousElementSibling;
    const divider = sibling instanceof HTMLElement && sibling.tagName === 'CE-DIVIDER' ? sibling : null;
    column.hidden = true;
    column.style.display = 'none';
    if (divider) {
      divider.hidden = true;
      divider.style.display = 'none';
    }
    this.collapsedColumnGroups.add(groupId);
    this.applyColumnFlex(row, columns);

    const button = this.ownerDocument.createElement('button');
    button.type = 'button';
    button.dataset.restoreColumn = side;
    const title = group.querySelector(':scope > ce-panel[active]')?.getAttribute('title') || (side === 'left' ? '左栏' : '右栏');
    button.textContent = title;
    button.setAttribute('aria-label', `展开 ${title}`);
    button.title = `展开 ${title}`;
    button.style.cssText = `
      order:${side === 'left' ? -1 : 1};flex:0 0 28px;min-width:0;
      writing-mode:vertical-rl;padding:10px 4px;overflow:hidden;
      border:1px solid var(--ce-border,#444);cursor:pointer;
      color:var(--ce-tab-fg-active,#fff);background:var(--ce-tabbar-bg,#2d2d2d);
      font:inherit;text-align:start;`;
    button.addEventListener('click', () => {
      this.collapsedColumnGroups.delete(groupId);
      column.hidden = false;
      column.style.removeProperty('display');
      if (divider) {
        divider.hidden = false;
        divider.style.removeProperty('display');
      }
      button.remove();
      this.applyColumnFlex(row, columns);
      bindResizableSplitPanes(this);
      group.shadowRoot?.querySelector<HTMLElement>('.tab-item.active')?.focus({ preventScroll: true });
    });
    this.append(button);
    if (focus) button.focus();
    return true;
  }

  private applyColumnFlex(row: HTMLElement, columns: HTMLElement[]): void {
    if (columns.every((column) => !column.hidden)) {
      const expanded = this.expandedRowFlex.get(row);
      this.expandedRowFlex.delete(row);
      if (expanded) {
        columns.forEach((column, index) => {
          column.removeAttribute('data-collapsed-row-grower');
          column.style.flex = expanded[index];
        });
        return;
      }
    }

    const root = this.querySelector<HTMLElement>(':scope > ce-split-pane > :not(ce-divider)');
    if (!this.layout || !root) return;
    const split = findRenderedSplit(this.layout, root, row);
    if (!split) return;
    const units = split.flexUnits ?? inferSplitFlexUnits(split.children.length, split.sizes);
    applyRowFlex(columns, split.sizes, units);
  }

  private persistRenderedLayoutSize(resizedDivider: HTMLElement | null): void {
    if (!this.layout) return;
    const renderedRoot = this.querySelector<HTMLElement>(':scope > ce-split-pane > :not(ce-divider)');
    if (!renderedRoot) return;

    const resizedSplit = resizedDivider?.parentElement;
    if (resizedSplit?.querySelector(':scope > [hidden]')) this.expandedRowFlex.delete(resizedSplit);
    this.layout = syncLayoutSizesFromDom(this.layout, renderedRoot, resizedDivider);
    this.saveCachedLayout();
  }

  private handlePanelWindowMessage(event: MessageEvent): void {
    this.handleWindowOpenReady(event);
    this.notifyOpenerPanelMounted(event);
    const panels = this.getRenderedPanels();
    const dispatchResult = parseTrustedDispatchResult(event, panels, this.pendingPanelRequests);
    if (dispatchResult && this.transport) {
      const pending = this.pendingPanelRequests.get(dispatchResult.requestId)!;
      window.clearTimeout(pending.timer);
      this.pendingPanelRequests.delete(dispatchResult.requestId);
      void this.transport.sendMessageResult(dispatchResult.requestId, dispatchResult.result)
        .catch((error) => console.error('Failed to relay panel dispatch result:', error));
      return;
    }
    const modalState = parseTrustedPanelModalState(event, panels);
    if (modalState) {
      modalState.panel.toggleAttribute('modal-open', modalState.open);
      return;
    }
    if (event.data?.type === 'panel-focus' && typeof event.data.panel === 'string') {
      this.focusPanelInActiveWindow(event.data.panel);
    }
    const trustedLocalPanel = event.source !== null && event.origin === new URL(window.location.href).origin && panels.some((panel) => (
      panel.shadowRoot?.querySelector('iframe')?.contentWindow === event.source
    ));
    this.handleChannelMessage(event.data, trustedLocalPanel);
  }

  private handleChannelMessage(payload: unknown, trustedLocalPanel = false): void {
    if (!payload || typeof payload !== 'object') return;
    const data = payload as { type?: unknown; payload?: unknown };
    if (data.type === 'ce-tab-drag-close-source' && isCloseSourceTabPayload(data.payload)) {
      this.handleCloseSourceTab(data.payload);
      return;
    }
    if (this.windowGroupKind !== 'main') return;
    if (data.type === 'ce-panel-docked' && isDockedPanelPayload(data.payload)) {
      this.removeFloatingPanel(data.payload.panelInstanceId);
      return;
    }
    if (data.type === 'ce-open-panel-result' && isOpenPanelResultPayload(data.payload)) {
      const result = data.payload;
      if (result.disposition === 'reuse' && result.carrier === 'floating') {
        if (trustedLocalPanel && this.hiddenFloatingIds.delete(result.panelInstanceId) && this.bootstrap) {
          writeHiddenFloatingIds(this.bootstrap, this.hiddenFloatingIds);
        }
        this.upsertFloatingPanel({
          id: result.panelInstanceId,
          panelName: result.panelName,
          state: 'open',
        });
      }
      return;
    }
    if (data.type !== 'ce-open-panel-floating' || !isFloatingPanelPayload(data.payload)) return;
    const floatingPayload = data.payload;
    if (floatingPayload.state === 'closed') {
      this.removeFloatingPanel(floatingPayload.id);
      return;
    }
    this.upsertFloatingPanel({
      id: floatingPayload.id,
      panelName: floatingPayload.panelName,
      state: floatingPayload.state,
    });
  }

  private createBootstrapFloatingPanels(bootstrap: BootstrapInfo): FloatingPanelState[] {
    return bootstrap.panelInstances
      .filter((instance): instance is BootstrapInfo['panelInstances'][number] & { state: 'open' | 'minimized' } => (
        instance.carrier === 'floating' && !this.hiddenFloatingIds.has(instance.id)
        && (instance.state === 'open' || instance.state === 'minimized')
      ))
      .map((instance, index) => this.createFloatingPanelState({
        id: instance.id,
        panelName: instance.panelName,
        state: 'open',
        index,
      }))
      .filter((panel): panel is FloatingPanelState => Boolean(panel));
  }

  private upsertFloatingPanel(panelPayload: { id: string; panelName: string; state?: 'opening' | 'open' | 'minimized' }): void {
    if (this.hiddenFloatingIds.has(panelPayload.id)) return;
    const index = this.floatingPanels.findIndex((item) => item.id === panelPayload.id);
    const current = index >= 0 ? this.floatingPanels[index] : undefined;
    const state = 'open';
    if (current?.panelName === panelPayload.panelName && current.state === state) return;
    const nextPanel = this.createFloatingPanelState({
      id: panelPayload.id,
      panelName: panelPayload.panelName,
      state,
      index: index >= 0 ? index : this.floatingPanels.length,
    });
    if (!nextPanel) return;
    if (current?.panelName === nextPanel.panelName && current.position) nextPanel.position = current.position;
    if (current?.panelName === nextPanel.panelName && current.size) nextPanel.size = current.size;

    this.floatingPanels = index < 0
      ? [...this.floatingPanels, nextPanel]
      : this.floatingPanels.map((item, itemIndex) => itemIndex === index ? nextPanel : item);
    this.syncFloatingPanelLayer();
  }

  private createFloatingPanelState(input: {
    id: string;
    panelName: string;
    state: 'open';
    index: number;
  }): FloatingPanelState | null {
    const panel = this.panelMap.get(input.panelName);
    if (!panel) return null;
    const availability = this.panelAvailability.get(input.panelName) ?? 'available';
    const revision = this.panelRevisions.get(input.panelName);

    return {
      id: input.id,
      panelName: input.panelName,
      title: panel.titleKey ? i18nStore.t(panel.titleKey) : (panel.title ?? panel.name),
      titleKey: panel.titleKey,
      src: availability === 'unavailable' ? '' : this.withSession(panel.entry, revision),
      availability,
      revision,
      state: input.state,
      position: { x: 80 + input.index * 24, y: 64 + input.index * 24 },
    };
  }

  private dockFloatingPanel(panelInstanceId: string, descriptor: Parameters<typeof dockFloatingPanelIntoLayout>[2]): void {
    if (!this.layout) return;

    const floating = this.floatingPanels.find((item) => item.id === panelInstanceId);
    if (!floating || floating.localOnly) return;

    this.layout = dockFloatingPanelIntoLayout(this.layout, {
      panelName: floating.panelName,
      title: floating.title,
      titleKey: floating.titleKey,
      src: floating.src,
    }, descriptor);
    this.removeFloatingPanel(panelInstanceId);
    this.saveCachedLayout();
    this.render();
    void this.transport?.closePanelInstance(panelInstanceId);
    this.channel?.postMessage({
      type: 'ce-panel-docked',
      payload: { panelInstanceId },
    });
  }

  private removeFloatingPanel(panelInstanceId: string): void {
    const next = this.floatingPanels.filter((item) => item.id !== panelInstanceId);
    if (next.length === this.floatingPanels.length) return;
    this.floatingPanels = next;
    this.syncFloatingPanelLayer();
  }

  private handleFloatingPanelCloseAction(event: Event): void {
    const panelInstanceId = getPanelInstanceIdFromEvent(event);
    if (!panelInstanceId) return;
    const panel = this.floatingPanels.find((item) => item.id === panelInstanceId);
    if (!panel) return;
    const pending = this.pendingWindowOpens.get(panelInstanceId);
    if (pending) this.cancelWindowOpen(pending);

    this.removeFloatingPanel(panelInstanceId);
    if (!panel.localOnly) {
      void this.transport?.closePanelInstance(panelInstanceId);
      this.broadcastFloatingPanelState(panel, 'closed');
    }
  }

  private floatingLayer(): (HTMLElement & { setOpeningWindow(id: string, opening: boolean): void; showWindowError(id: string, message: string): void }) | null {
    return this.querySelector('floating-panel-layer');
  }

  private async openFloatingPanelWindow(panelId: string): Promise<void> {
    const panel = this.floatingPanels.find((item) => item.id === panelId);
    const sessionId = this.bootstrap?.sessionId;
    if (!panel || !sessionId || this.pendingWindowOpens.has(panelId)) return;
    const layer = this.floatingLayer();
    layer?.showWindowError(panelId, '');
    const popup = window.open('about:blank', '_blank');
    if (!popup) { layer?.showWindowError(panelId, '浏览器阻止了新窗口，请允许弹窗后重试。'); return; }
    const pending: PendingWindowOpen = {
      panelId, panelName: panel.panelName, sessionId, token: this.initToken, nonce: generateUUID(), popup,
      timer: 0, poll: 0, cancelled: false, cleaned: false,
    };
    this.pendingWindowOpens.set(panelId, pending);
    layer?.setOpeningWindow(panelId, true);
    pending.timer = window.setTimeout(() => this.cancelWindowOpen(pending, '新窗口加载超时，请重试。'), 20_000);
    pending.poll = window.setInterval(() => {
      if (popup.closed) this.cancelWindowOpen(pending, '新窗口已关闭，请重试。');
    }, 300);
    try {
      const response = await fetch('/api/panel/open-window', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, panelName: panel.panelName }),
      });
      const result: unknown = await response.json();
      if (!response.ok || !isNewPanelWindowResult(result, panel.panelName)) throw new Error('无法创建新窗口。');
      pending.windowGroupId = result.windowGroupId;
      if (pending.cancelled || this.initToken !== pending.token || this.bootstrap?.sessionId !== sessionId || popup.closed) {
        this.cancelWindowOpen(pending);
        return;
      }
      const url = new URL(result.url, window.location.href);
      if (url.origin !== new URL(window.location.href).origin || url.pathname !== '/api/window-entry/secondary'
        || url.searchParams.get('sessionId') !== sessionId || url.searchParams.get('windowGroupId') !== result.windowGroupId) throw new Error('新窗口地址无效。');
      url.searchParams.set('openNonce', pending.nonce);
      url.searchParams.set('openPanel', panel.panelName);
      popup.location.href = url.toString();
    } catch {
      if (!pending.cancelled) this.cancelWindowOpen(pending, '无法打开新窗口，请重试。');
      else this.cleanupCreatedWindow(pending);
    }
  }

  private cleanupCreatedWindow(pending: PendingWindowOpen): void {
    if (!pending.windowGroupId || pending.cleaned) return;
    pending.cleaned = true;
    void fetch('/api/window-group/close', {
      method: 'POST', headers: { 'content-type': 'application/json' }, keepalive: true,
      body: JSON.stringify({ sessionId: pending.sessionId, windowGroupId: pending.windowGroupId }),
    }).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    }).catch((error) => console.error('清理新窗口失败', error));
  }

  private cancelWindowOpen(pending: PendingWindowOpen, error?: string): void {
    pending.cancelled = true;
    window.clearTimeout(pending.timer);
    window.clearInterval(pending.poll);
    const current = this.pendingWindowOpens.get(pending.panelId);
    if (current === pending) this.pendingWindowOpens.delete(pending.panelId);
    try { if (!pending.popup.closed) pending.popup.close(); } catch { /* The window may already be gone. */ }
    this.cleanupCreatedWindow(pending);
    if (!current || current === pending) {
      this.floatingLayer()?.setOpeningWindow(pending.panelId, false);
      if (error && this.isConnected) this.floatingLayer()?.showWindowError(pending.panelId, error);
    }
  }

  private cancelPendingWindowOpens(): void {
    for (const pending of this.pendingWindowOpens.values()) this.cancelWindowOpen(pending);
  }

  private handleWindowOpenReady(event: MessageEvent): void {
    if (event.origin !== new URL(window.location.href).origin || !event.data || event.data.type !== 'ce-window-panel-mounted') return;
    for (const pending of this.pendingWindowOpens.values()) {
      if (pending.popup !== event.source || pending.cancelled || pending.popup.closed || pending.token !== this.initToken
        || pending.sessionId !== this.bootstrap?.sessionId || !pending.windowGroupId
        || event.data.nonce !== pending.nonce || event.data.sessionId !== pending.sessionId
        || event.data.windowGroupId !== pending.windowGroupId || event.data.panelName !== pending.panelName) continue;
      window.clearTimeout(pending.timer);
      window.clearInterval(pending.poll);
      this.pendingWindowOpens.delete(pending.panelId);
      // The old server-floating instance may be shared with another device; only remove this page's view.
      const panel = this.floatingPanels.find((item) => item.id === pending.panelId);
      if (panel && !panel.localOnly && this.bootstrap) {
        this.hiddenFloatingIds.add(panel.id);
        writeHiddenFloatingIds(this.bootstrap, this.hiddenFloatingIds);
      }
      this.removeFloatingPanel(pending.panelId);
      return;
    }
  }

  private notifyOpenerPanelMounted(event: MessageEvent): void {
    if (this.windowGroupKind !== 'secondary' || !window.opener || event.origin !== new URL(window.location.href).origin
      || !event.data || event.data.type !== 'panel-mounted' || !this.bootstrap) return;
    const params = new URLSearchParams(window.location.search);
    const nonce = params.get('openNonce');
    const panelName = params.get('openPanel');
    const windowGroupId = params.get('windowGroupId');
    if (!nonce || !panelName || !windowGroupId || this.renderedWindow?.id !== windowGroupId
      || event.data.panel !== panelName || !this.getRenderedPanels().some((panel) => (
        panel.getAttribute('data-panel-name') === panelName && panel.shadowRoot?.querySelector('iframe')?.contentWindow === event.source
      ))) return;
    window.opener.postMessage({ type: 'ce-window-panel-mounted', nonce, panelName, windowGroupId, sessionId: this.bootstrap.sessionId }, event.origin);
  }

  private syncFloatingPanelLayer(): void {
    const layer = this.querySelector('floating-panel-layer');
    if (!layer) return;
    layer.setAttribute('data-state', JSON.stringify(this.floatingPanels));
    queueMicrotask(() => {
      if (this.isConnected) this.syncIframeThemes();
    });
  }

  private updateFloatingPanelGeometry(event: Event): void {
    const detail = (event as CustomEvent).detail as { panelInstanceId?: unknown; position?: { x?: unknown; y?: unknown }; size?: { width?: unknown; height?: unknown } } | undefined;
    if (!detail || typeof detail.panelInstanceId !== 'string' || !detail.position || !detail.size) return;
    const { x, y } = detail.position;
    const { width, height } = detail.size;
    if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)
      || typeof width !== 'number' || !Number.isFinite(width) || width <= 0
      || typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return;
    const index = this.floatingPanels.findIndex((item) => item.id === detail.panelInstanceId);
    if (index < 0) return;
    const current = this.floatingPanels[index];
    if (current.position?.x === x && current.position?.y === y && current.size?.width === width && current.size?.height === height) return;
    this.floatingPanels = this.floatingPanels.map((item, i) => i === index ? { ...item, position: { x, y }, size: { width, height } } : item);
    this.syncFloatingPanelLayer();
  }

  private broadcastFloatingPanelState(panel: FloatingPanelState, state: 'closed'): void {
    this.channel?.postMessage({
      type: 'ce-open-panel-floating',
      payload: {
        id: panel.id,
        panelName: panel.panelName,
        state,
      },
    });
  }

  private cleanupSecondaryWindowGroup(beacon: boolean): void {
    if (this.windowGroupKind !== 'secondary' || this.secondaryWindowCleanupSent) return;

    const windowGroupId = this.getWindowGroupIdFromURL() ?? this.renderedWindow?.id;
    if (!windowGroupId) return;

    this.secondaryWindowCleanupSent = true;
    void this.transport?.closeWindowGroup(windowGroupId, { beacon });
  }

  private handleCloseSourceTab(payload: {
    sessionId: string;
    sourceWindowId: string;
    sourceGroupId: string;
    sourceTabId: string;
  }): void {
    if (!this.layout || !this.session || payload.sessionId !== this.session.sessionId) return;
    const currentWindowId = this.getWindowGroupIdFromURL() ?? this.renderedWindow?.id;
    if (!currentWindowId || payload.sourceWindowId !== currentWindowId) return;
    if (!layoutGroupContainsTab(this.layout, payload.sourceGroupId, payload.sourceTabId)) return;

    const next = removeTabFromLayout(this.layout, payload.sourceTabId);
    if (next === this.layout) return;
    this.layout = next;
    this.saveCachedLayout();
    this.render();
  }

  private focusPanelInActiveWindow(panelName: string): void {
    const activePanel = Array.from(this.querySelectorAll('ce-panel'))
      .find((panel) => panel.getAttribute('data-panel-name') === panelName) as HTMLElement | undefined;
    if (!activePanel) return;

    const group = activePanel.closest('ce-panel-group');
    if (!group) return;

    group.querySelectorAll(':scope > ce-panel').forEach((panel) => panel.removeAttribute('active'));
    activePanel.setAttribute('active', '');
    group.dispatchEvent(new CustomEvent('ce-panel-change', { bubbles: true }));
  }

  private loadCachedLayout(kitName: string, windowId: string, defaultSignature: string): EditorLayoutNode | null {
    if (!this.session || !this.bootstrap) return null;
    const layout = this.layoutStorage.load<EditorLayoutNode>(kitName, windowId, defaultSignature);
    return layout ? rebindLayoutRuntime(layout, this.session.sessionId, windowId) : null;
  }

  private saveCachedLayout(): void {
    if (!this.bootstrap || !this.defaultLayoutSignature || !this.layout) return;
    const windowGroup = this.renderedWindow ?? this.bootstrap.windows[0];
    if (!windowGroup) return;
    try {
      this.layoutStorage.save(this.bootstrap.kitName ?? 'unknown-kit', windowGroup.id, this.defaultLayoutSignature, this.layout);
    } catch {
      // Ignore storage failures in private mode or quota-limited environments.
    }
  }

  private getRenderedPanels(): Element[] {
    const panels = Array.from(this.querySelectorAll('ce-panel'));
    const floatingLayer = this.querySelector('floating-panel-layer');
    if (floatingLayer?.shadowRoot) {
      panels.push(...floatingLayer.shadowRoot.querySelectorAll('ce-panel'));
    }
    return panels;
  }

  private clearPendingPanelRequests(): void {
    for (const pending of this.pendingPanelRequests.values()) window.clearTimeout(pending.timer);
    this.pendingPanelRequests.clear();
  }

  private syncIframeThemes(): void {
    const liveIframes = new Set<HTMLIFrameElement>();
    for (const panel of this.getRenderedPanels()) {
      if (!panel.hasAttribute('src')) continue;
      const iframe = panel.shadowRoot?.querySelector('iframe');
      if (!iframe) {
        continue;
      }
      liveIframes.add(iframe);
      if (!this.iframeThemeBindings.has(iframe)) {
        this.iframeThemeBindings.set(iframe, bindThemeToIframe(iframe, () => this.hostThemeTokens));
      }
    }

    for (const [iframe, dispose] of this.iframeThemeBindings) {
      if (liveIframes.has(iframe)) continue;
      dispose();
      this.iframeThemeBindings.delete(iframe);
    }
  }

  private handlePanelAvailabilityChanged(event: object): void {
    const record = event as Record<string, unknown>;
    if (!isPanelAvailabilityChangedEvent(record)) return;

    const previousRevision = this.panelRevisions.get(record.panel.name);
    if (previousRevision !== undefined && record.revision <= previousRevision) return;
    this.panelRevisions.set(record.panel.name, record.revision);
    this.panelAvailability.set(record.panel.name, record.state);

    if (record.state === 'available') {
      this.panelMap.set(record.panel.name, record.panel);
      if (this.bootstrap) {
        this.bootstrap = {
          ...this.bootstrap,
          panels: this.bootstrap.panels.map((panel) => (
            panel.name === record.panel.name ? record.panel : panel
          )),
        };
      }
    }

    const descriptor = this.panelMap.get(record.panel.name) ?? record.panel;
    if (!this.panelMap.has(record.panel.name)) {
      this.panelMap.set(record.panel.name, descriptor);
    }
    const src = record.state === 'available'
      ? this.withSession(descriptor.entry, record.revision)
      : '';
    this.querySelectorAll<HTMLElement>('ce-panel').forEach((panel) => {
      if (panel.getAttribute('data-panel-name') !== record.panel.name) return;
      this.applyPanelAvailabilityToElement(panel, src, record.state, record.revision);
    });

    const floatingLayer = this.querySelector('floating-panel-layer') as (HTMLElement & {
      updatePanelAvailability?: (input: {
        panelName: string;
        src: string;
        state: 'available' | 'unavailable';
        revision: number;
      }) => void;
    }) | null;
    floatingLayer?.updatePanelAvailability?.({
      panelName: record.panel.name,
      src,
      state: record.state,
      revision: record.revision,
    });
    this.floatingPanels = this.floatingPanels.map((panel) => panel.panelName === record.panel.name
      ? {
        ...panel,
        src,
        availability: record.state,
        revision: record.revision,
      }
      : panel);
    queueMicrotask(() => {
      if (this.isConnected) this.syncIframeThemes();
    });
  }

  private applyPanelAvailabilityToElement(
    panel: HTMLElement,
    src: string,
    state: 'available' | 'unavailable',
    revision: number,
  ): void {
    panel.setAttribute('data-panel-revision', String(revision));
    if (state === 'unavailable') {
      panel.removeAttribute('src');
      panel.setAttribute('availability', 'unavailable');
      return;
    }
    panel.setAttribute('availability', 'available');
    panel.setAttribute('src', src);
  }

  private clearIframeThemeBindings(): void {
    for (const dispose of this.iframeThemeBindings.values()) {
      dispose();
    }
    this.iframeThemeBindings.clear();
  }

  private dispatchPanelEvent(event: object): void {
    const record = event as Record<string, unknown>;
    const panel = typeof record.panel === 'string' ? record.panel : '';
    const method = typeof record.method === 'string' ? record.method : '';
    const args = Array.isArray(record.args) ? record.args : [];
    const requestId = typeof record.requestId === 'string' ? record.requestId : undefined;
    if (!panel || !method) return;

    const targets = this.getRenderedPanels().filter((candidate) => (
      candidate.hasAttribute('src') && candidate.getAttribute('data-panel-name') === panel
      && candidate.shadowRoot?.querySelector('iframe')?.contentWindow
    ));
    if (requestId && this.pendingPanelRequests.has(requestId)) return;
    for (const target of requestId ? targets.slice(0, 1) : targets) {
      const targetWindow = target.shadowRoot?.querySelector('iframe')?.contentWindow;
      if (!targetWindow) continue;
      if (requestId) {
        const timer = window.setTimeout(() => this.pendingPanelRequests.delete(requestId), 12_000);
        this.pendingPanelRequests.set(requestId, { source: targetWindow, timer });
      }
      targetWindow.postMessage({
        type: 'panel-dispatch', panel, method, args, requestId,
      }, '*');
    }
  }

  private handleI18nEvent(event: object): void {
    const record = event as Record<string, unknown>;
    const snapshot = isI18nSnapshot(record.i18n) ? record.i18n : undefined;
    if (snapshot) {
      const changeEvent = toI18nChangeEvent(record, snapshot);
      i18nStore.replaceVisibleSnapshot(snapshot, changeEvent);
      this.refreshLayoutTitles();
      this.postI18nEventToPanels(event);
    }

    if (Array.isArray(record.menuTree) && this.session) {
      this.handleMenuEvent(event);
    }
  }

  private handleMenuEvent(event: object): void {
    const record = event as Record<string, unknown>;
    if (!Array.isArray(record.menuTree) || !this.session) return;
    const menuTree = record.menuTree as BootstrapInfo['menuTree'];
    const applicationMenuTree = Array.isArray(record.applicationMenuTree)
      ? record.applicationMenuTree as BootstrapInfo['applicationMenuTree']
      : this.bootstrap?.applicationMenuTree ?? [];
    const kitMenuTree = Array.isArray(record.kitMenuTree)
      ? record.kitMenuTree as BootstrapInfo['kitMenuTree']
      : this.bootstrap?.kitMenuTree ?? [];
    this.bootstrap = this.bootstrap
      ? { ...this.bootstrap, menuTree, applicationMenuTree, kitMenuTree }
      : this.bootstrap;
    this.mountMenuRuntime({
      sessionId: this.bootstrap?.sessionId ?? this.session.sessionId,
      menuMode: getMenuModeFromURL(),
      menuTree,
      applicationMenuTree,
      kitMenuTree,
      kitMenuRoot: this.bootstrap?.kitMenuRoot ?? null,
    });
  }

  private mountMenuRuntime(input: MenuRuntimeInput): void {
    if (this.menuRuntime) this.menuRuntime.update(input);
    else this.menuRuntime = mountMenuRuntime(input);
    const container = this.querySelector<HTMLElement>('[data-web-menu]');
    if (container) this.menuRuntime.attach(container);
  }

  private refreshLayoutTitles(): void {
    if (!this.layout) return;
    // 只更新内存中的 layout 数据，DOM 上的 ce-panel 会自行响应 i18n store 热更新 title 属性，
    // 避免在切换语言时整棵布局重新渲染、导致 iframe 被重建（看起来像页面刷新）。
    this.layout = mapLayoutTitles(this.layout, (titleKey, fallback) => (
      titleKey ? i18nStore.t(titleKey) : fallback
    ));
  }

  private postI18nEventToPanels(event: object): void {
    for (const panel of this.getRenderedPanels()) {
      if (!panel.hasAttribute('src')) continue;
      panel.shadowRoot?.querySelector('iframe')?.contentWindow?.postMessage(event, '*');
    }
  }

  private broadcastLayoutResizeState(resizing: boolean): void {
    const message = { type: resizing ? 'layout-resize-start' : 'layout-resize-end' };
    for (const panel of this.querySelectorAll('ce-panel[src]')) {
      panel.shadowRoot?.querySelector('iframe')?.contentWindow?.postMessage(message, '*');
    }
  }

  private renderEditorLayoutNode(
    node: EditorLayoutNode,
    size?: number,
    unit: EditorSplitFlexUnit = 'fr',
    parentDirection?: EditorSplitNode['direction'],
    reserveFlexibleWidth = false,
  ): string {
    const shrinkPixels = parentDirection === 'row' && !this.isFixedEditorNode(node, size, unit);
    const style = this.renderSizeStyle(size, unit, shrinkPixels);
    if (node.kind === 'panel') {
      return this.renderStaticPanel(node, style, size, unit);
    }
    if (node.kind === 'group') {
      const minimum = parentDirection === 'row'
        ? unit === 'fr' && reserveFlexibleWidth
          ? 'min-width:max(var(--layout-min-width, 0px), min(120px, 30%));'
          : 'min-width:var(--layout-min-width, 0px);'
        : '';
      return this.renderGroup(node, style + minimum);
    }

    const flexUnits = node.flexUnits ?? inferSplitFlexUnits(node.children.length, node.sizes);
    const reserveChildWidth = flexUnits.filter((childUnit) => childUnit === 'fr').length === 1;
    return `
      <ce-split-pane direction="${node.direction}" style="${style}">
        ${node.children.map((child, index) => {
          const childUnit = flexUnits[index] ?? 'fr';
          const childHtml = this.renderEditorLayoutNode(child, node.sizes?.[index], childUnit, node.direction, reserveChildWidth);
          if (index === 0) {
            return childHtml;
          }

          const previous = node.children[index - 1];
          const previousSize = node.sizes?.[index - 1];
          const previousUnit = flexUnits[index - 1] ?? 'fr';
          const skipDivider = this.isFixedEditorNode(previous, previousSize, previousUnit)
            || this.isFixedEditorNode(child, node.sizes?.[index], childUnit);
          return skipDivider ? childHtml : `<ce-divider></ce-divider>${childHtml}`;
        }).join('')}
      </ce-split-pane>
    `;
  }

  private renderGroup(group: EditorGroupNode, style: string): string {
    return `
      <ce-panel-group
        style="${style}"
        data-group-id="${escapeAttr(group.groupId)}"
        data-session-id="${escapeAttr(group.sessionId)}"
        data-window-id="${escapeAttr(group.windowId)}"
      >
        ${group.tabs.map((tab) => this.renderGroupTab(tab, tab.tabId === group.activeTabId)).join('')}
      </ce-panel-group>
    `;
  }

  private renderGroupTab(tab: EditorGroupNode['tabs'][number], active: boolean): string {
    if (tab.content.type === 'leaf') {
      return `
        <ce-panel
          title="${escapeAttr(tab.title)}"
          ${tab.titleKey ? `title-i18n="${escapeAttr(tab.titleKey)}"` : ''}
          data-tab-id="${escapeAttr(tab.tabId)}"
          data-panel-name="${escapeAttr(tab.panelName)}"
          ${active ? 'active ' : ''}
          ${this.renderPanelSourceAttributes(tab.panelName, tab.src)}
          style="min-width:0;min-height:0;background:transparent;"
        ></ce-panel>
      `;
    }

    return `
      <ce-panel
        title="${escapeAttr(tab.title)}"
        ${tab.titleKey ? `title-i18n="${escapeAttr(tab.titleKey)}"` : ''}
        data-tab-id="${escapeAttr(tab.tabId)}"
        data-panel-name="${escapeAttr(tab.panelName)}"
        ${active ? 'active ' : ''}
        style="min-width:0;min-height:0;background:transparent;"
      >
        ${this.renderNestedLayout(tab.content)}
      </ce-panel>
    `;
  }

  private renderNestedLayout(node: LayoutNode): string {
    if (!this.session || !this.bootstrap) return '';
    const nested = createEditorLayout(node, this.panelMap, this.session.sessionId, 'nested');
    return this.renderEditorLayoutNode(nested);
  }

  private renderStaticPanel(node: EditorPanelNode, style: string, size?: number, unit: EditorSplitFlexUnit = 'fr'): string {
    const fixed = this.isFixedEditorNode(node, size, unit) ? ` data-layout-fixed="true" data-layout-size="${size}"` : '';
    return `
      <ce-panel
        type="simple"
        chromeless
        ${node.titleKey ? `title-i18n="${escapeAttr(node.titleKey)}"` : ''}
        data-panel-id="${escapeAttr(node.panelId)}"
        data-panel-name="${escapeAttr(node.panelName)}"
        ${fixed}
        style="${style}"
        ${this.renderPanelSourceAttributes(node.panelName, node.src)}
      ></ce-panel>
    `;
  }

  private renderSizeStyle(size: number | undefined, unit: EditorSplitFlexUnit, shrinkPixels: boolean): string {
    const flex = size !== undefined && unit === 'px' ? `0 ${shrinkPixels ? 1 : 0} ${size}px` : `${size ?? 1} 1 0`;
    return `flex:${flex};min-height:0;min-width:0;background:transparent;`;
  }

  private isFixedEditorNode(node: EditorLayoutNode, size: number | undefined, unit: EditorSplitFlexUnit): boolean {
    return node.kind === 'panel'
      && node.panelType === 'simple'
      && size !== undefined
      && unit === 'px';
  }

  private renderLoadingLayout(message = 'Loading kit layout...', retry = false): string {
    return `
      <ce-panel type="simple" chromeless style="flex:1;display:flex;">
        <div style="
          display:flex;
          flex:1;
          flex-direction:column;
          gap:8px;
          align-items:center;
          justify-content:center;
          color:var(--ce-text-secondary,#888);
          font-size:13px;
        ">
          <span${retry ? ' role="alert"' : ''}>${escapeHtml(message)}</span>
          ${retry ? '<button type="button" data-retry-initialization>重试</button>' : ''}
        </div>
      </ce-panel>
    `;
  }

  private renderPanelSourceAttributes(panelName: string, entry?: string): string {
    const revision = this.panelRevisions.get(panelName);
    const unavailable = this.panelAvailability.get(panelName) === 'unavailable';
    const revisionAttribute = revision === undefined ? '' : `data-panel-revision="${revision}"`;
    const availabilityAttribute = unavailable ? 'availability="unavailable"' : '';
    const currentEntry = this.panelMap.get(panelName)?.entry ?? entry;
    const src = currentEntry && !unavailable ? this.withSession(currentEntry, revision) : '';
    return `${availabilityAttribute} ${revisionAttribute} ${src ? `src="${escapeAttr(src)}"` : ''}`;
  }

  private withSession(entry: string, revision?: number): string {
    const url = new URL(entry, window.location.origin || 'http://localhost');
    url.searchParams.set('sessionId', this.bootstrap?.sessionId ?? this.session?.sessionId ?? '');
    if (revision !== undefined) url.searchParams.set('panelRevision', String(revision));
    // Only host-created panels opt into Kit UI initialization. This marker is
    // not an authorization credential; the server validates the session.
    url.searchParams.set('panelUi', '1');
    return `${url.pathname}${url.search}`;
  }

  private getWindowGroupIdFromURL(): string | null {
    const windowGroupId = new URLSearchParams(window.location.search).get('windowGroupId');
    return windowGroupId && windowGroupId.trim().length > 0 ? windowGroupId : null;
  }
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function createDefaultLayoutSignature(
  layout: LayoutNode,
  panelMap: Map<string, BootstrapInfo['panels'][number]>,
): string {
  const panels = Array.from(panelMap.values())
    .map((panel) => ({
      name: panel.name,
      entry: panel.entry,
      title: panel.title,
      titleKey: panel.titleKey,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return stableStringify({ layout, panels });
}

function rebindLayoutRuntime(node: EditorLayoutNode, sessionId: string, windowId: string): EditorLayoutNode {
  if (node.kind === 'split') {
    return {
      ...node,
      children: node.children.map((child) => rebindLayoutRuntime(child, sessionId, windowId)),
    };
  }

  if (node.kind === 'group') {
    return {
      ...node,
      sessionId,
      windowId,
      tabs: node.tabs.map((tab) => ({
        ...tab,
        sessionId,
        windowId,
      })),
    };
  }

  return {
    ...node,
    sessionId,
    windowId,
  };
}

function setActiveTab(node: EditorLayoutNode, groupId: string, tabId: string): EditorLayoutNode {
  if (node.kind === 'split') {
    return {
      ...node,
      children: node.children.map((child) => setActiveTab(child, groupId, tabId)),
    };
  }

  if (node.kind === 'group' && node.groupId === groupId) {
    return {
      ...node,
      activeTabId: node.tabs.some((tab) => tab.tabId === tabId) ? tabId : node.activeTabId,
    };
  }

  return node;
}

function layoutFlex(size: number | undefined, unit: EditorSplitFlexUnit, shrinkPixels: boolean, folded: boolean): string {
  if (size === undefined) return '1 1 0px';
  if (unit === 'fr') return `${size} 1 0px`;
  if (!shrinkPixels) return `0 0 ${size}px`;
  // In a folded row, keep a visible sidebar from taking the space freed for the workspace.
  return folded ? `0 1 min(${size}px, 50%)` : `0 1 ${size}px`;
}

function layoutChildren(element: HTMLElement): HTMLElement[] {
  return Array.from(element.children).filter((child): child is HTMLElement => (
    child instanceof HTMLElement && child.tagName !== 'CE-DIVIDER'
  ));
}

function findRenderedSplit(node: EditorLayoutNode, element: HTMLElement, target: HTMLElement): EditorSplitNode | undefined {
  if (node.kind !== 'split') return;
  if (element === target) return node;
  const children = layoutChildren(element);
  const index = children.findIndex((child) => child.contains(target));
  if (index !== -1 && node.children[index]) return findRenderedSplit(node.children[index], children[index], target);
}

function collapsedRowGrower(columns: HTMLElement[], units: EditorSplitFlexUnit[]): HTMLElement | undefined {
  if (columns.some((column) => column.hidden) && !columns.some((column, index) => !column.hidden && units[index] !== 'px')) {
    return columns.filter((column) => !column.hidden).at(-1);
  }
}

function applyRowFlex(
  columns: HTMLElement[], sizes: number[] | undefined, units: EditorSplitFlexUnit[], resizedDivider?: HTMLElement | null,
): void {
  const grower = collapsedRowGrower(columns, units);
  const folded = columns.some((column) => column.hidden);
  columns.forEach((column, index) => {
    const cap = folded && column !== resizedDivider?.previousElementSibling && column !== resizedDivider?.nextElementSibling;
    column.toggleAttribute('data-collapsed-row-grower', column === grower);
    column.style.flex = column === grower
      ? '1 1 0px'
      : layoutFlex(sizes?.[index], units[index] ?? 'fr', column.dataset.layoutFixed !== 'true', cap);
  });
}

function syncLayoutSizesFromDom(node: EditorLayoutNode, element: HTMLElement, resizedDivider: HTMLElement | null): EditorLayoutNode {
  if (node.kind !== 'split') {
    return node;
  }

  const children = layoutChildren(element);
  const resizedSplit = resizedDivider?.parentElement ?? null;
  const flexUnits = node.flexUnits ?? inferSplitFlexUnits(node.children.length, node.sizes);
  const grower = collapsedRowGrower(children, flexUnits);
  const nextChildren = node.children.map((child, index) => {
    const childElement = children[index];
    if (!childElement || childElement.hidden || (childElement === grower && !grower.contains(resizedSplit))) return child;
    return syncLayoutSizesFromDom(child, childElement, resizedDivider);
  });
  const hasCollapsedColumn = children.some((child) => child.hidden);
  if (resizedSplit && !isSplitInResizePath(element, resizedSplit)) return { ...node, children: nextChildren };
  if (hasCollapsedColumn && element !== resizedSplit) return { ...node, children: nextChildren };

  const axis = node.direction === 'column' ? 'height' : 'width';
  const measured = children.map((child) => child.hidden ? null : readRenderedSize(child, axis));
  const hasHiddenFlexibleChild = children.some((child, index) => child.hidden && flexUnits[index] === 'fr');
  const flexibleShare = hasHiddenFlexibleChild ? children.reduce((total, child, index) => (
    total + (!child.hidden && flexUnits[index] === 'fr' ? node.sizes?.[index] ?? 1 : 0)
  ), 0) : 1;

  // 计算所有 fr 子节点占据的总像素，用来反推每个 fr 子节点的相对份额
  let flexibleTotalPx = 0;
  measured.forEach((size, index) => {
    if (flexUnits[index] === 'fr' && typeof size === 'number' && size > 0) {
      flexibleTotalPx += size;
    }
  });

  const sizes = node.children.map((_, index) => {
    const unit = flexUnits[index];
    const size = measured[index];
    const child = children[index];
    if (child && (child.hidden || child === grower)) return node.sizes?.[index] ?? 1;
    if (unit === 'px') {
      if (node.direction === 'row' && element === resizedSplit && child !== resizedDivider?.previousElementSibling
        && child !== resizedDivider?.nextElementSibling && node.sizes?.[index] !== undefined) {
        return node.sizes[index];
      }
      // 固定子节点：保留实际像素值
      return typeof size === 'number' && size > 0 ? Number(size.toFixed(2)) : node.sizes?.[index];
    }
    // 弹性子节点：归一化为 <=1 的份额
    if (typeof size === 'number' && size > 0 && flexibleTotalPx > 0) {
      return Number((size / flexibleTotalPx * flexibleShare).toFixed(6));
    }
    return node.sizes?.[index];
  });

  const allValid = sizes.every((size): size is number => typeof size === 'number' && size > 0);
  if (hasCollapsedColumn && allValid) {
    applyRowFlex(children, sizes, flexUnits, resizedDivider);
  }

  return {
    ...node,
    children: nextChildren,
    sizes: allValid ? sizes : node.sizes,
    flexUnits,
  };
}

function readRenderedSize(element: HTMLElement, axis: 'width' | 'height'): number | null {
  const measured = axis === 'width' ? element.getBoundingClientRect().width : element.getBoundingClientRect().height;
  if (measured > 0) return Number(measured.toFixed(2));

  const flexBasis = parseFloat(element.style.flexBasis);
  if (Number.isFinite(flexBasis) && flexBasis > 0) return flexBasis;

  const flexMatch = element.style.flex.match(/(\d+(?:\.\d+)?)px/);
  if (flexMatch) return Number(flexMatch[1]);
  return null;
}

function createSessionBroadcastChannel(sessionId: string): BroadcastChannel | null {
  if (typeof BroadcastChannel !== 'function') return null;
  try {
    return new BroadcastChannel(`ce-session:${sessionId}`);
  } catch {
    return null;
  }
}

function layoutGroupContainsTab(node: EditorLayoutNode, groupId: string, tabId: string): boolean {
  if (node.kind === 'group') {
    return node.groupId === groupId && node.tabs.some((tab) => tab.tabId === tabId);
  }
  if (node.kind === 'panel') return false;
  return node.children.some((child) => layoutGroupContainsTab(child, groupId, tabId));
}

function createEmptyI18nSnapshot(): I18nVisibleSnapshot {
  return {
    locale: 'zh-CN',
    defaultLocale: 'zh-CN',
    version: 0,
    currentMessages: {},
    defaultMessages: {},
  };
}

function isI18nSnapshot(value: unknown): value is I18nVisibleSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<I18nVisibleSnapshot>;
  return typeof snapshot.locale === 'string'
    && typeof snapshot.defaultLocale === 'string'
    && typeof snapshot.version === 'number'
    && typeof snapshot.currentMessages === 'object'
    && typeof snapshot.defaultMessages === 'object';
}

function isFloatingPanelPayload(value: unknown): value is {
  id: string;
  panelName: string;
  state?: 'opening' | 'open' | 'minimized' | 'closed';
} {
  if (!value || typeof value !== 'object') return false;
  const payload = value as { id?: unknown; panelName?: unknown; state?: unknown };
  return typeof payload.id === 'string'
    && typeof payload.panelName === 'string'
    && (
      payload.state === undefined
      || payload.state === 'opening'
      || payload.state === 'open'
      || payload.state === 'minimized'
      || payload.state === 'closed'
    );
}

function isPanelAvailabilityChangedEvent(value: Record<string, unknown>): value is {
  type: 'panel-availability-changed';
  panel: BootstrapInfo['panels'][number];
  state: 'available' | 'unavailable';
  revision: number;
} {
  const panel = value.panel;
  if (!panel || typeof panel !== 'object') return false;
  const descriptor = panel as { name?: unknown; entry?: unknown };
  return value.type === 'panel-availability-changed'
    && typeof descriptor.name === 'string'
    && typeof descriptor.entry === 'string'
    && (value.state === 'available' || value.state === 'unavailable')
    && typeof value.revision === 'number'
    && Number.isFinite(value.revision)
    && value.revision >= 0;
}

function isOpenPanelResultPayload(value: unknown): value is {
  disposition: 'reuse' | 'open-window-group';
  panelInstanceId: string;
  panelName: string;
  windowGroupId: string | null;
  carrier: 'window-group' | 'floating';
} {
  if (!value || typeof value !== 'object') return false;
  const payload = value as {
    disposition?: unknown;
    panelInstanceId?: unknown;
    panelName?: unknown;
    windowGroupId?: unknown;
    carrier?: unknown;
  };
  return (payload.disposition === 'reuse' || payload.disposition === 'open-window-group')
    && typeof payload.panelInstanceId === 'string'
    && typeof payload.panelName === 'string'
    && (typeof payload.windowGroupId === 'string' || payload.windowGroupId === null)
    && (payload.carrier === 'window-group' || payload.carrier === 'floating');
}

function isDockedPanelPayload(value: unknown): value is { panelInstanceId: string } {
  if (!value || typeof value !== 'object') return false;
  const payload = value as { panelInstanceId?: unknown };
  return typeof payload.panelInstanceId === 'string';
}

function isCloseSourceTabPayload(value: unknown): value is {
  sessionId: string;
  sourceWindowId: string;
  sourceGroupId: string;
  sourceTabId: string;
} {
  if (!value || typeof value !== 'object') return false;
  const payload = value as {
    sessionId?: unknown;
    sourceWindowId?: unknown;
    sourceGroupId?: unknown;
    sourceTabId?: unknown;
  };
  return typeof payload.sessionId === 'string'
    && typeof payload.sourceWindowId === 'string'
    && typeof payload.sourceGroupId === 'string'
    && typeof payload.sourceTabId === 'string';
}

function getPanelInstanceIdFromEvent(event: Event): string {
  const detail = (event as CustomEvent<{ panelInstanceId?: unknown }>).detail;
  return typeof detail?.panelInstanceId === 'string' ? detail.panelInstanceId : '';
}

function hiddenFloatingKey(bootstrap: BootstrapInfo): string {
  return `itharbors:hidden-floating:v1:${encodeURIComponent(JSON.stringify([bootstrap.sessionId, bootstrap.kitName ?? '']))}`;
}

function readHiddenFloatingIds(bootstrap: BootstrapInfo): Set<string> {
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(hiddenFloatingKey(bootstrap)) ?? '[]');
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []);
  } catch { return new Set(); }
}

function writeHiddenFloatingIds(bootstrap: BootstrapInfo, ids: Set<string>): void {
  try { window.sessionStorage.setItem(hiddenFloatingKey(bootstrap), JSON.stringify([...ids])); }
  catch { /* The view remains hidden until this page is reloaded. */ }
}

function isNewPanelWindowResult(value: unknown, panelName: string): value is { windowGroupId: string; url: string } {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return result.disposition === 'open-window-group' && result.carrier === 'window-group'
    && result.panelName === panelName && typeof result.panelInstanceId === 'string' && result.panelInstanceId.length > 0
    && typeof result.windowGroupId === 'string' && result.windowGroupId.length > 0 && typeof result.url === 'string';
}

function parseTrustedDispatchResult(
  event: MessageEvent,
  panels: Element[],
  pendingRequests: Map<string, { source: Window; timer: number }>,
): { requestId: string; result: { ok: true; value: unknown } | { ok: false; error: string } } | null {
  if (!event.data || typeof event.data !== 'object' || event.data.type !== 'dispatch-result') return null;
  if (typeof event.data.requestId !== 'string' || event.data.requestId.length === 0
    || pendingRequests.get(event.data.requestId)?.source !== event.source) return null;
  const trusted = Array.from(panels).some((panel) => (
    panel.shadowRoot?.querySelector('iframe')?.contentWindow === event.source
  ));
  if (!trusted) return null;
  if (typeof event.data.error === 'string') {
    return { requestId: event.data.requestId, result: { ok: false, error: event.data.error } };
  }
  if (Object.prototype.hasOwnProperty.call(event.data, 'result')) {
    return { requestId: event.data.requestId, result: { ok: true, value: event.data.result } };
  }
  return null;
}

function parseTrustedPanelModalState(
  event: MessageEvent,
  panels: Element[],
): { panel: HTMLElement; open: boolean } | null {
  if (!event.data || typeof event.data !== 'object' || event.data.type !== 'ce-panel-modal-state') return null;
  if (typeof event.data.open !== 'boolean') return null;
  const panel = Array.from(panels).find((candidate) => (
    candidate.shadowRoot?.querySelector('iframe')?.contentWindow === event.source
  ));
  return panel instanceof HTMLElement ? { panel, open: event.data.open } : null;
}

function toI18nChangeEvent(event: Record<string, unknown>, snapshot: I18nVisibleSnapshot): I18nChangeEvent {
  if (event.type === 'locale-changed') {
    return {
      type: 'locale-changed',
      locale: typeof event.locale === 'string' ? event.locale : snapshot.locale,
      version: Number(event.version ?? snapshot.version),
    };
  }
  return {
    type: 'messages-changed',
    version: Number(event.version ?? snapshot.version),
    changedKeys: Array.isArray(event.changedKeys) ? event.changedKeys.filter((key): key is string => typeof key === 'string') : [],
    affectsFallback: Boolean(event.affectsFallback),
  };
}

customElements.define('editor-app', EditorApp);
