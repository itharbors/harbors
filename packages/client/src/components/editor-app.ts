import { EditorTransport, getKitFromURL, getSessionIdFromURL } from '../core/transport';
import type { BootstrapInfo, I18nChangeEvent, I18nVisibleSnapshot, LayoutNode } from '../core/session';
import { ClientSession } from '../core/session';
import { I18nClient } from '../i18n/client';
import { i18nStore } from '../i18n/store';
import '../layout/split-pane';
import '../layout/divider';
import '../layout/panel';
import '../layout/panel-group';
import './floating-panel-layer';
import { bindResizableSplitPanes } from '../layout/resizable-split';
import { TabDragController } from '../layout/tab-drag-controller';
import {
  createEditorLayout,
  dockFloatingPanel as dockFloatingPanelIntoLayout,
  removeTabFromLayout,
  type EditorGroupNode,
  type EditorLayoutNode,
  type EditorPanelNode,
  type EditorSplitFlexUnit,
  inferSplitFlexUnits,
  mapLayoutTitles,
} from '../layout/tab-layout';
import { createWindowLayoutStorage } from '../layout/storage';
import { DEFAULT_THEME_TOKENS, renderThemeVariables, type ThemeTokens } from '../styles/theme';
import { applyThemeToDocument } from '../styles/iframe-theme';
import { getElectronMenuModeFromURL, mountMenuRuntime, type MenuRuntimeInput } from '../menu/runtime';
import type { FloatingPanelState } from './floating-panel-layer';

export class EditorApp extends HTMLElement {
  private session: ClientSession | null = null;
  private transport: EditorTransport | null = null;
  private lastSSEEvent: string = '—';
  private workspacePath: string = '—';
  private bootstrap: BootstrapInfo | null = null;
  private panelMap = new Map<string, BootstrapInfo['panels'][number]>();
  private layout: EditorLayoutNode | null = null;
  private dragController: TabDragController | null = null;
  private hostThemeTokens: ThemeTokens = DEFAULT_THEME_TOKENS;
  private initToken = 0;
  private i18nClient: I18nClient | null = null;
  private menuRuntimeDispose: (() => void) | null = null;
  private renderedWindow: BootstrapInfo['windows'][number] | null = null;
  private floatingPanels: FloatingPanelState[] = [];
  private channel: BroadcastChannel | null = null;
  private readonly layoutStorage = createWindowLayoutStorage({
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
  });
  private defaultLayoutSignature: string | null = null;
  private handlePanelChange = (event: Event) => this.handlePanelGroupChange(event);
  private handleDividerDragStart = () => this.broadcastLayoutResizeState(true);
  private handleDividerDragEnd = () => {
    this.broadcastLayoutResizeState(false);
    this.persistRenderedLayoutSize();
  };
  private handleWindowMessage = (event: MessageEvent) => this.handlePanelWindowMessage(event);
  private handleChannelMessageEvent = (event: MessageEvent) => this.handleChannelMessage(event.data);
  private handleSecondaryPageHide = () => this.cleanupSecondaryWindowGroup(true);
  private handleSecondaryBeforeUnload = () => this.cleanupSecondaryWindowGroup(true);
  private handleFloatingPanelMinimize = (event: Event) => this.handleFloatingPanelAction(event, 'minimized');
  private handleFloatingPanelRestore = (event: Event) => this.handleFloatingPanelAction(event, 'open');
  private handleFloatingPanelClose = (event: Event) => this.handleFloatingPanelCloseAction(event);
  private secondaryWindowCleanupSent = false;
  // 窗口缩放期间频繁触发 panel iframe 的重新布局，会让 WebGL/Canvas 面板反复 setSize 导致闪烁。
  // 我们用 debounce：第一次 resize 广播 layout-resize-start，停止 resize 一段时间后再广播 layout-resize-end。
  private windowResizing = false;
  private windowResizeEndTimer: number | null = null;
  private static readonly WINDOW_RESIZE_END_DELAY_MS = 150;
  private handleWindowResize = () => this.handleWindowResizeTick();

  connectedCallback() {
    this.style.display = 'flex';
    this.style.width = '100%';
    this.style.height = '100%';
    this.style.minWidth = '0';
    this.style.minHeight = '0';
    this.style.overflow = 'hidden';
    this.style.position = 'relative';

    const sessionId = getSessionIdFromURL() || crypto.randomUUID();

    // If URL has no session param, redirect to include it.
    const searchParams = new URLSearchParams(window.location.search);
    if (!searchParams.has('session') && !searchParams.has('sessionId')) {
      const url = new URL(window.location.href);
      url.searchParams.set('session', sessionId);
      window.history.replaceState({}, '', url.toString());
    }

    this.session = new ClientSession(sessionId);
    this.transport = new EditorTransport(this.session, { kit: getKitFromURL() || undefined });
    this.i18nClient = new I18nClient(sessionId);
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
    this.addEventListener('ce-divider-drag-start', this.handleDividerDragStart);
    this.addEventListener('ce-divider-drag-end', this.handleDividerDragEnd);
    this.addEventListener('ce-floating-panel-minimize', this.handleFloatingPanelMinimize);
    this.addEventListener('ce-floating-panel-restore', this.handleFloatingPanelRestore);
    this.addEventListener('ce-floating-panel-close', this.handleFloatingPanelClose);
    window.addEventListener('resize', this.handleWindowResize);
    window.addEventListener('message', this.handleWindowMessage);
    if (this.windowGroupKind === 'secondary') {
      window.addEventListener('pagehide', this.handleSecondaryPageHide);
      window.addEventListener('beforeunload', this.handleSecondaryBeforeUnload);
    }

    this.render();
    this.initToken += 1;
    void this.init(this.initToken);
  }

  disconnectedCallback() {
    this.initToken += 1;
    this.clearPanelModalState();
    this.transport?.disconnectSSE();
    this.channel?.removeEventListener('message', this.handleChannelMessageEvent);
    this.channel?.close();
    this.channel = null;
    this.menuRuntimeDispose?.();
    this.menuRuntimeDispose = null;
    this.i18nClient = null;
    this.removeEventListener('ce-panel-change', this.handlePanelChange);
    this.removeEventListener('ce-divider-drag-start', this.handleDividerDragStart);
    this.removeEventListener('ce-divider-drag-end', this.handleDividerDragEnd);
    this.removeEventListener('ce-floating-panel-minimize', this.handleFloatingPanelMinimize);
    this.removeEventListener('ce-floating-panel-restore', this.handleFloatingPanelRestore);
    this.removeEventListener('ce-floating-panel-close', this.handleFloatingPanelClose);
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
    try {
      const info = await this.transport!.fetchSessionInfo();
      if (token !== this.initToken || !this.isConnected) return;
      this.workspacePath = info.workspacePath || '（未设置）';
      const bootstrap = await this.transport!.fetchBootstrap();
      if (token !== this.initToken || !this.isConnected) return;
      this.bootstrap = bootstrap;
      i18nStore.hydrate(bootstrap.i18n ?? createEmptyI18nSnapshot());
      this.mountMenuRuntime({
        sessionId: bootstrap.sessionId,
        menuMode: getElectronMenuModeFromURL(),
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
      this.floatingPanels = this.createBootstrapFloatingPanels(bootstrap);
      this.layout = null;
      this.defaultLayoutSignature = null;
      this.renderedWindow = null;
      this.render();
    } catch (err) {
      if (token !== this.initToken || !this.isConnected) return;
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
    const content = this.layout
      ? this.renderEditorLayoutNode(this.layout)
      : this.bootstrap
        ? this.renderBootstrapLayout(this.bootstrap)
        : this.renderLoadingLayout();
    const floatingLayer = this.windowGroupKind === 'main'
      ? `<floating-panel-layer data-state="${escapeAttr(JSON.stringify(this.floatingPanels))}"></floating-panel-layer>`
      : '';
    this.innerHTML = `
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
        ${renderThemeVariables(this.hostThemeTokens)}
      ">
        ${content}
      </ce-split-pane>
      ${floatingLayer}
    `;
    bindResizableSplitPanes(this);
    queueMicrotask(() => this.syncIframeThemes());
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

  private persistRenderedLayoutSize(): void {
    if (!this.layout) return;
    const outer = this.querySelector(':scope > ce-split-pane');
    const renderedRoot = Array.from(outer?.children ?? [])
      .find((child) => child.tagName.toLowerCase() !== 'ce-divider') as HTMLElement | undefined;
    if (!renderedRoot) return;

    this.layout = syncLayoutSizesFromDom(this.layout, renderedRoot);
    this.saveCachedLayout();
  }

  private handlePanelWindowMessage(event: MessageEvent): void {
    const dispatchResult = parseTrustedDispatchResult(event, this.querySelectorAll('ce-panel'));
    if (dispatchResult && this.transport) {
      void this.transport.sendMessageResult(dispatchResult.requestId, dispatchResult.result)
        .catch((error) => console.error('Failed to relay panel dispatch result:', error));
      return;
    }
    const modalState = parseTrustedPanelModalState(event, this.querySelectorAll('ce-panel'));
    if (modalState) {
      modalState.panel.toggleAttribute('modal-open', modalState.open);
      return;
    }
    if (event.data?.type === 'panel-focus' && typeof event.data.panel === 'string') {
      this.focusPanelInActiveWindow(event.data.panel);
    }
    this.handleChannelMessage(event.data);
  }

  private handleChannelMessage(payload: unknown): void {
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
        instance.carrier === 'floating' && (instance.state === 'open' || instance.state === 'minimized')
      ))
      .map((instance, index) => this.createFloatingPanelState({
        id: instance.id,
        panelName: instance.panelName,
        state: instance.state,
        index,
      }))
      .filter((panel): panel is FloatingPanelState => Boolean(panel));
  }

  private upsertFloatingPanel(panelPayload: { id: string; panelName: string; state?: 'opening' | 'open' | 'minimized' }): void {
    const index = this.floatingPanels.findIndex((item) => item.id === panelPayload.id);
    const nextPanel = this.createFloatingPanelState({
      id: panelPayload.id,
      panelName: panelPayload.panelName,
      state: panelPayload.state === 'minimized' ? 'minimized' : 'open',
      index: index >= 0 ? index : this.floatingPanels.length,
    });
    if (!nextPanel) return;

    this.floatingPanels = [
      ...this.floatingPanels.filter((item) => item.id !== nextPanel.id),
      nextPanel,
    ];
    this.render();
  }

  private createFloatingPanelState(input: {
    id: string;
    panelName: string;
    state: 'open' | 'minimized';
    index: number;
  }): FloatingPanelState | null {
    const panel = this.panelMap.get(input.panelName);
    if (!panel) return null;

    return {
      id: input.id,
      panelName: input.panelName,
      title: panel.titleKey ? i18nStore.t(panel.titleKey) : (panel.title ?? panel.name),
      titleKey: panel.titleKey,
      src: this.withSession(panel.entry),
      state: input.state,
      position: input.state === 'open'
        ? { x: 80 + input.index * 24, y: 64 + input.index * 24 }
        : undefined,
      edge: input.state === 'minimized' ? 'bottom' : undefined,
    };
  }

  private dockFloatingPanel(panelInstanceId: string, descriptor: Parameters<typeof dockFloatingPanelIntoLayout>[2]): void {
    if (!this.layout) return;

    const floating = this.floatingPanels.find((item) => item.id === panelInstanceId);
    if (!floating) return;

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
    this.render();
  }

  private handleFloatingPanelAction(event: Event, state: 'open' | 'minimized'): void {
    const panelInstanceId = getPanelInstanceIdFromEvent(event);
    if (!panelInstanceId) return;
    const panel = this.setFloatingPanelState(panelInstanceId, state);
    if (!panel) return;

    void this.transport?.setPanelInstanceState(panelInstanceId, state);
    this.broadcastFloatingPanelState(panel, state);
  }

  private handleFloatingPanelCloseAction(event: Event): void {
    const panelInstanceId = getPanelInstanceIdFromEvent(event);
    if (!panelInstanceId) return;
    const panel = this.floatingPanels.find((item) => item.id === panelInstanceId);
    if (!panel) return;

    this.removeFloatingPanel(panelInstanceId);
    void this.transport?.closePanelInstance(panelInstanceId);
    this.broadcastFloatingPanelState(panel, 'closed');
  }

  private setFloatingPanelState(panelInstanceId: string, state: 'open' | 'minimized'): FloatingPanelState | null {
    const index = this.floatingPanels.findIndex((item) => item.id === panelInstanceId);
    const current = index >= 0 ? this.floatingPanels[index] : undefined;
    if (!current) return null;

    const next = this.createFloatingPanelState({
      id: current.id,
      panelName: current.panelName,
      state,
      index,
    });
    if (!next) return null;

    this.floatingPanels = this.floatingPanels.map((item) => (item.id === panelInstanceId ? next : item));
    this.render();
    return next;
  }

  private broadcastFloatingPanelState(panel: FloatingPanelState, state: 'open' | 'minimized' | 'closed'): void {
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

  private syncIframeThemes(): void {
    for (const panel of this.querySelectorAll('ce-panel[src]')) {
      const iframe = panel.shadowRoot?.querySelector('iframe');
      if (!iframe) {
        continue;
      }

      if (iframe.dataset.themeBound !== 'true') {
        iframe.dataset.themeBound = 'true';
        iframe.addEventListener('load', () => {
          if (iframe.contentDocument) {
            applyThemeToDocument(iframe.contentDocument, this.hostThemeTokens);
          }
        });
      }

      if (iframe.contentDocument) {
        applyThemeToDocument(iframe.contentDocument, this.hostThemeTokens);
      }
    }
  }

  private dispatchPanelEvent(event: object): void {
    const record = event as Record<string, unknown>;
    const panel = typeof record.panel === 'string' ? record.panel : '';
    const method = typeof record.method === 'string' ? record.method : '';
    const args = Array.isArray(record.args) ? record.args : [];
    const requestId = typeof record.requestId === 'string' ? record.requestId : undefined;
    if (!panel || !method) return;

    const panelElement = Array.from(this.querySelectorAll('ce-panel[src]')).find((candidate) => {
      return candidate.getAttribute('data-panel-name') === panel;
    });
    const iframe = panelElement?.shadowRoot?.querySelector('iframe');
    iframe?.contentWindow?.postMessage({
      type: 'panel-dispatch',
      panel,
      method,
      args,
      requestId,
    }, '*');
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
      sessionId: this.session.sessionId,
      menuMode: getElectronMenuModeFromURL(),
      menuTree,
      applicationMenuTree,
      kitMenuTree,
      kitMenuRoot: this.bootstrap?.kitMenuRoot ?? null,
    });
  }

  private mountMenuRuntime(input: MenuRuntimeInput): void {
    this.menuRuntimeDispose?.();
    const runtime = mountMenuRuntime(input);
    this.menuRuntimeDispose = runtime.dispose;
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
    for (const panel of this.querySelectorAll('ce-panel[src]')) {
      panel.shadowRoot?.querySelector('iframe')?.contentWindow?.postMessage(event, '*');
    }
  }

  private broadcastLayoutResizeState(resizing: boolean): void {
    const message = { type: resizing ? 'layout-resize-start' : 'layout-resize-end' };
    for (const panel of this.querySelectorAll('ce-panel[src]')) {
      panel.shadowRoot?.querySelector('iframe')?.contentWindow?.postMessage(message, '*');
    }
  }

  private renderEditorLayoutNode(node: EditorLayoutNode, size?: number, unit: EditorSplitFlexUnit = 'fr'): string {
    if (node.kind === 'panel') {
      return this.renderStaticPanel(node, this.renderSizeStyle(size, unit), size, unit);
    }
    if (node.kind === 'group') {
      return this.renderGroup(node, this.renderSizeStyle(size, unit));
    }

    const flexUnits = node.flexUnits ?? inferSplitFlexUnits(node.children.length, node.sizes);
    return `
      <ce-split-pane direction="${node.direction}" style="${this.renderSizeStyle(size, unit)}min-height:0;min-width:0;">
        ${node.children.map((child, index) => {
          const childUnit = flexUnits[index] ?? 'fr';
          const childHtml = this.renderEditorLayoutNode(child, node.sizes?.[index], childUnit);
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
          ${tab.src ? `src="${escapeAttr(this.withSession(tab.src))}"` : ''}
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
        ${node.src ? `src="${escapeAttr(this.withSession(node.src))}"` : ''}
      ></ce-panel>
    `;
  }

  private renderSizeStyle(size?: number, unit: EditorSplitFlexUnit = 'fr'): string {
    if (size === undefined) return 'flex:1 1 0;min-height:0;min-width:0;background:transparent;';
    if (unit === 'px') return `flex:0 0 ${size}px;min-height:0;min-width:0;background:transparent;`;
    return `flex:${size} 1 0;min-height:0;min-width:0;background:transparent;`;
  }

  private isFixedEditorNode(node: EditorLayoutNode, size: number | undefined, unit: EditorSplitFlexUnit): boolean {
    return node.kind === 'panel'
      && node.panelType === 'simple'
      && size !== undefined
      && unit === 'px';
  }

  private renderLoadingLayout(message = 'Loading kit layout...'): string {
    return `
      <ce-panel type="simple" chromeless style="flex:1;display:flex;">
        <div style="
          display:flex;
          flex:1;
          align-items:center;
          justify-content:center;
          color:var(--ce-text-secondary,#888);
          font-size:13px;
        ">${escapeHtml(message)}</div>
      </ce-panel>
    `;
  }

  private withSession(entry: string): string {
    const url = new URL(entry, window.location.origin || 'http://localhost');
    url.searchParams.set('sessionId', this.session?.sessionId ?? '');
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

function syncLayoutSizesFromDom(node: EditorLayoutNode, element: HTMLElement): EditorLayoutNode {
  if (node.kind !== 'split') {
    return node;
  }

  const children = Array.from(element.children)
    .filter((child) => child.tagName.toLowerCase() !== 'ce-divider') as HTMLElement[];
  const nextChildren = node.children.map((child, index) => (
    children[index] ? syncLayoutSizesFromDom(child, children[index]) : child
  ));
  const axis = node.direction === 'column' ? 'height' : 'width';
  const flexUnits = node.flexUnits ?? inferSplitFlexUnits(node.children.length, node.sizes);
  const measured = children.map((child) => readRenderedSize(child, axis));

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
    if (unit === 'px') {
      // 固定子节点：保留实际像素值
      return typeof size === 'number' && size > 0 ? Number(size.toFixed(2)) : node.sizes?.[index];
    }
    // 弹性子节点：归一化为 <=1 的份额
    if (typeof size === 'number' && size > 0 && flexibleTotalPx > 0) {
      return Number((size / flexibleTotalPx).toFixed(6));
    }
    return node.sizes?.[index];
  });

  const allValid = sizes.every((size): size is number => typeof size === 'number' && size > 0);

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

function parseTrustedDispatchResult(
  event: MessageEvent,
  panels: NodeListOf<Element>,
): { requestId: string; result: { ok: true; value: unknown } | { ok: false; error: string } } | null {
  if (!event.data || typeof event.data !== 'object' || event.data.type !== 'dispatch-result') return null;
  const trusted = Array.from(panels).some((panel) => (
    panel.shadowRoot?.querySelector('iframe')?.contentWindow === event.source
  ));
  if (!trusted || typeof event.data.requestId !== 'string' || event.data.requestId.length === 0) return null;
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
  panels: NodeListOf<Element>,
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
