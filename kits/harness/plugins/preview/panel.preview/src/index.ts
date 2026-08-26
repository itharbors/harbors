import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { syncWebContent, webContentMarkup } from './web-view.js';
import {
  LONG_PRESS_MS,
  clampPan,
  clampViewportHeight,
  clampViewportWidth,
  isTapDistance,
  moveCursor,
  normalizeViewportState,
  type ViewportState,
} from './viewport.js';

import { validatePreviewLink, type PreviewLinkPayload } from './uri.js';
import {
  activatePreviewTab,
  closePreviewTab,
  createPreviewState,
  getPreviewSession,
  openPreviewTab,
  previewKey,
  previewSessionKey,
  resolvePreviewTab,
  updatePreviewTab,
  selectPreviewSession,
  type PreviewContent,
  type PreviewState,
  type PreviewTab,
} from './state.js';

marked.setOptions({ gfm: true, breaks: true });

interface PanelContext {
  message: {
    request(plugin: string, name: string, ...args: unknown[]): Promise<unknown>;
  };
}

interface TabDom {
  view: HTMLElement;
  content: PreviewContent | null;
}

interface WebPageContent extends PreviewContent {
  kind: 'url';
}

export interface ProxySessionResponse {
  sessionId: string;
  port: number;
  path: string;
  expiresAt: number;
}

const MAX_PROXY_PATH_LENGTH = 4096;

/** Validate the narrow response contract returned by the Preview proxy. */
export function validateProxySessionResponse(value: unknown): ProxySessionResponse {
  if (!value || typeof value !== 'object') throw new Error('代理响应格式无效');
  const result = value as Record<string, unknown>;
  if (typeof result.sessionId !== 'string' || result.sessionId.length === 0 || result.sessionId.length > 256
    || /[\u0000-\u0020]/.test(result.sessionId)) {
    throw new Error('代理会话 ID 无效');
  }
  if (!Number.isInteger(result.port) || (result.port as number) < 1 || (result.port as number) > 65535) {
    throw new Error('代理端口无效');
  }
  if (typeof result.path !== 'string' || result.path.length === 0 || result.path.length > MAX_PROXY_PATH_LENGTH
    || !result.path.startsWith('/') || result.path.startsWith('//') || /[\u0000-\u0020]/.test(result.path)) {
    throw new Error('代理路径无效');
  }
  if (!Number.isFinite(result.expiresAt) || (result.expiresAt as number) <= Date.now()) {
    throw new Error('代理会话已过期');
  }
  return {
    sessionId: result.sessionId,
    port: result.port as number,
    path: result.path,
    expiresAt: result.expiresAt as number,
  };
}

/** Build the browser-visible local proxy URL from the current page host. */
export function buildProxyUrl(response: ProxySessionResponse, locationHref = window.location.href): string {
  response = validateProxySessionResponse(response);
  const location = new URL(locationHref);
  if (location.protocol !== 'http:') throw new Error('HTTPS 页面暂不支持本地代理（会产生混合内容）');
  const origin = `${location.protocol}//${location.hostname}:${response.port}`;
  const proxy = new URL(response.path, origin);
  const normalizedPort = response.port === 80 ? '' : String(response.port);
  if (proxy.protocol !== location.protocol || proxy.hostname !== location.hostname || proxy.port !== normalizedPort) {
    throw new Error('代理地址与当前页面主机不匹配');
  }
  return proxy.href;
}

let ctx: PanelContext | null = null;
let previewState: PreviewState = createPreviewState();
let nextTabId = 0;
let nextRequestId = 0;
let mountGeneration = 0;
let selectionRevision = 0;
const sessionDom = new Map<string, Map<string, TabDom>>();
const resizeObservers = new WeakMap<HTMLElement, ResizeObserver>();

function renderMarkdown(content: string): string {
  try {
    const html = marked.parse(content, { async: false });
    return DOMPurify.sanitize(typeof html === 'string' ? html : String(html));
  } catch {
    return `<pre class="preview-code"><code>${escapeHtml(content)}</code></pre>`;
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function contentMarkup(content: PreviewContent): string {
  if (content.error) {
    return `<div class="preview-body"><div class="preview-error">${escapeHtml(content.error)}</div></div>`;
  }

  if (content.kind === 'url') {
    return webContentMarkup(content as WebPageContent);
  }

  if (content.kind === 'file' && content.language === 'image') {
    return `<div class="preview-body"><img class="preview-image" src="${escapeHtml(content.content || '')}" alt="${escapeHtml(content.title || '')}" /></div>`;
  }

  if (content.kind === 'file' && content.content !== undefined) {
    const body = content.language === 'markdown'
      ? `<div class="preview-markdown">${renderMarkdown(content.content)}</div>`
      : `<pre class="preview-code"><code>${escapeHtml(content.content)}</code></pre>`;
    return `<div class="preview-body">${body}</div>`;
  }

  if (content.kind === 'unsupported') {
    return `<div class="preview-body"><div class="preview-error">${escapeHtml(content.error || '不支持预览此类型的内容')}</div></div>`;
  }

  return '<div class="preview-body"><div class="preview-loading">正在加载…</div></div>';
}

function updateTabDom(sessionKey: string, tab: PreviewTab, dom: TabDom): void {
  if (dom.content === tab.content) return;
  const gesture = dom.view.querySelector<HTMLElement>('[data-preview-gesture-layer]');
  if (gesture && dom.content?.interactionMode === 'virtual' && tab.content.interactionMode !== 'virtual') cleanupGesture(gesture);
  if (dom.content?.kind === 'url' && tab.content.kind === 'url' && syncWebContent(dom.view, tab.content)) {
    bindWebViewEvents(dom.view, sessionKey, tab.id);
    layoutWebView(dom.view, tab.content);
    dom.content = tab.content;
    return;
  }
  dom.view.innerHTML = contentMarkup(tab.content);
  bindWebViewEvents(dom.view, sessionKey, tab.id);
  if (tab.content.kind === 'url') layoutWebView(dom.view, tab.content);
  dom.content = tab.content;
}

function cleanupTabDom(view: HTMLElement): void {
  const gesture = view.querySelector<HTMLElement>('[data-preview-gesture-layer]');
  if (gesture) cleanupGesture(gesture);
  const clip = view.querySelector<HTMLElement>('[data-preview-web-clip]');
  if (clip) {
    resizeObservers.get(clip)?.disconnect();
    resizeObservers.delete(clip);
  }
}

function closeTab(sessionKey: string, id: string): void {
  const tab = getPreviewSession(previewState, sessionKey).tabs.find((item) => item.id === id);
  const proxySessionId = tab?.content.proxySessionId;
  if (proxySessionId) {
    void ctx?.message.request('preview', 'closeProxyPage', { sessionId: proxySessionId }).catch(() => undefined);
  }
  previewState = closePreviewTab(previewState, sessionKey, id);
  renderState();
}

function bindNavigationEvents(nav: HTMLElement): void {
  nav.querySelectorAll<HTMLElement>('[data-preview-close-id]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const id = button.dataset.previewCloseId;
      const sessionKey = button.closest<HTMLElement>('[data-preview-session-key]')?.dataset.previewSessionKey;
      if (id && sessionKey) closeTab(sessionKey, id);
    });
  });
  nav.querySelectorAll<HTMLElement>('.preview-tab-select').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const tab = button.closest<HTMLElement>('[data-preview-tab-id]');
      const id = tab?.dataset.previewTabId;
      const sessionKey = tab?.dataset.previewSessionKey;
      if (!id || !sessionKey) return;
      previewState = activatePreviewTab(previewState, sessionKey, id);
      renderState();
    });
  });
}

function bindWebViewEvents(view: HTMLElement, sessionKey: string, tabId: string): void {
  view.querySelectorAll<HTMLElement>('[data-preview-interaction-mode]').forEach((button) => {
    if (button.dataset.previewBound) return;
    button.dataset.previewBound = 'true';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const mode = button.dataset.previewInteractionMode;
      if (mode !== 'direct' && mode !== 'virtual') return;
      const tab = getPreviewSession(previewState, sessionKey).tabs.find((item) => item.id === tabId);
      if (tab?.content.kind !== 'url') return;
      const current = normalizeViewportState(tab.content);
      const clip = view.querySelector<HTMLElement>('[data-preview-web-clip]');
      const cursorPatch: Partial<ViewportState> = {};
      if (mode === 'virtual' && clip && clip.clientWidth > 0 && clip.clientHeight > 0
        && (current.cursorX < current.panX || current.cursorX >= current.panX + clip.clientWidth
          || current.cursorY < current.panY || current.cursorY >= current.panY + clip.clientHeight)) {
        cursorPatch.cursorX = Math.min(current.viewportWidth - 1, current.panX + Math.floor(clip.clientWidth / 2));
        cursorPatch.cursorY = Math.min(current.viewportHeight - 1, current.panY + Math.floor(clip.clientHeight / 2));
      }
      previewState = updatePreviewTab(previewState, sessionKey, tabId, {
        content: { ...tab.content, interactionMode: mode, ...cursorPatch },
      });
      renderState();
    });
  });
  const bindDimension = (selector: string, dimension: 'viewportWidth' | 'viewportHeight') => {
    const input = view.querySelector<HTMLInputElement>(selector);
    if (!input || input.dataset.previewBound) return;
    input.dataset.previewBound = 'true';
    input.addEventListener('change', () => {
      const value = dimension === 'viewportWidth' ? clampViewportWidth(input.valueAsNumber) : clampViewportHeight(input.valueAsNumber);
      updateWebState(sessionKey, tabId, { [dimension]: value }, view);
    });
  };
  bindDimension('[data-preview-viewport-width]', 'viewportWidth');
  bindDimension('[data-preview-viewport-height]', 'viewportHeight');
  const gesture = view.querySelector<HTMLElement>('[data-preview-gesture-layer]');
  if (gesture && !gesture.dataset.previewBound) {
    gesture.dataset.previewBound = 'true';
    bindGestureEvents(gesture, view, sessionKey, tabId);
  }
  const clip = view.querySelector<HTMLElement>('[data-preview-web-clip]');
  if (clip && !clip.dataset.previewResizeBound) {
    clip.dataset.previewResizeBound = 'true';
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        const tab = getPreviewSession(previewState, sessionKey).tabs.find((item) => item.id === tabId);
        if (tab?.content.kind !== 'url') return;
        const state = normalizeViewportState(tab.content);
        const clamped = moveCursor(state, 0, 0, clip.clientWidth, clip.clientHeight);
        if (clamped.panX !== state.panX || clamped.panY !== state.panY) updateWebState(sessionKey, tabId, clamped, view);
        else layoutWebView(view, tab.content);
      });
      observer.observe(clip);
      resizeObservers.set(clip, observer);
    }
  }
}

interface ActiveGesture {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
  longPressed: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

const activeGestures = new WeakMap<HTMLElement, ActiveGesture>();

function cleanupGesture(layer: HTMLElement): void {
  const active = activeGestures.get(layer);
  if (!active) return;
  if (active.timer) clearTimeout(active.timer);
  try { layer.releasePointerCapture?.(active.pointerId); } catch { /* pointer capture may already be released */ }
  activeGestures.delete(layer);
}

function updateWebState(sessionKey: string, tabId: string, patch: Partial<ViewportState>, view?: HTMLElement): void {
  const tab = getPreviewSession(previewState, sessionKey).tabs.find((item) => item.id === tabId);
  if (tab?.content.kind !== 'url') return;
  let normalized = normalizeViewportState({ ...tab.content, ...patch });
  const clip = view?.querySelector<HTMLElement>('[data-preview-web-clip]');
  if (clip) {
    normalized = 'viewportWidth' in patch || 'viewportHeight' in patch
      ? moveCursor(normalized, 0, 0, clip.clientWidth, clip.clientHeight)
      : clampPan(normalized, clip.clientWidth, clip.clientHeight);
  }
  previewState = updatePreviewTab(previewState, sessionKey, tabId, {
    content: { ...tab.content, ...normalized },
  });
  if (previewState.selectedSessionKey === sessionKey) renderState();
}

function layoutWebView(view: HTMLElement, content: PreviewContent): void {
  const clip = view.querySelector<HTMLElement>('[data-preview-web-clip]');
  const canvas = view.querySelector<HTMLElement>('[data-preview-web-canvas]');
  if (!clip || !canvas) return;
  const state = clampPan(normalizeViewportState(content), clip.clientWidth, clip.clientHeight);
  const offsetX = state.viewportWidth < clip.clientWidth ? Math.floor((clip.clientWidth - state.viewportWidth) / 2) : -state.panX;
  const offsetY = state.viewportHeight < clip.clientHeight ? Math.floor((clip.clientHeight - state.viewportHeight) / 2) : -state.panY;
  canvas.style.transform = `translate(${offsetX}px, ${offsetY}px)`;
  const cursor = view.querySelector<HTMLElement>('[data-preview-virtual-cursor]');
  if (cursor) cursor.style.transform = `translate(${offsetX + state.cursorX}px, ${offsetY + state.cursorY}px)`;
}

function postPointerCommand(view: HTMLElement, content: PreviewContent, command: 'move' | 'click' | 'contextmenu'): void {
  const state = normalizeViewportState(content);
  const frame = view.querySelector<HTMLIFrameElement>('.preview-iframe');
  if (!frame?.contentWindow || !content.proxySessionId) return;
  frame.contentWindow.postMessage({
    version: 1,
    type: 'harbors.preview.pointer',
    sessionId: content.proxySessionId,
    command,
    x: state.cursorX,
    y: state.cursorY,
    viewportWidth: state.viewportWidth,
    viewportHeight: state.viewportHeight,
  }, '*');
}

function bindGestureEvents(layer: HTMLElement, view: HTMLElement, sessionKey: string, tabId: string): void {
  layer.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cleanupGesture(layer);
      updateWebState(sessionKey, tabId, { interactionMode: 'direct' }, view);
    }
  });
  layer.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    cleanupGesture(layer);
    const active: ActiveGesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
      longPressed: false,
    };
    active.timer = setTimeout(() => {
      const current = activeGestures.get(layer);
      if (current !== active || current.moved) return;
      current.longPressed = true;
      const tab = getPreviewSession(previewState, sessionKey).tabs.find((item) => item.id === tabId);
      if (tab?.content.kind === 'url') postPointerCommand(view, tab.content, 'contextmenu');
    }, LONG_PRESS_MS);
    activeGestures.set(layer, active);
    try { layer.setPointerCapture?.(event.pointerId); } catch { /* unsupported host */ }
  });
  layer.addEventListener('pointermove', (event) => {
    const active = activeGestures.get(layer);
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    const totalX = event.clientX - active.startX;
    const totalY = event.clientY - active.startY;
    if (!isTapDistance(totalX, totalY)) {
      active.moved = true;
      if (active.timer) clearTimeout(active.timer);
      active.timer = undefined;
    }
    const tab = getPreviewSession(previewState, sessionKey).tabs.find((item) => item.id === tabId);
    const clip = view.querySelector<HTMLElement>('[data-preview-web-clip]');
    if (tab?.content.kind !== 'url' || !clip) return;
    const next = moveCursor(normalizeViewportState(tab.content), event.clientX - active.lastX, event.clientY - active.lastY, clip.clientWidth, clip.clientHeight);
    active.lastX = event.clientX;
    active.lastY = event.clientY;
    updateWebState(sessionKey, tabId, next);
    const current = getPreviewSession(previewState, sessionKey).tabs.find((item) => item.id === tabId);
    if (current?.content.kind === 'url') postPointerCommand(view, current.content, 'move');
  });
  const finish = (event: PointerEvent, cancelled: boolean) => {
    const active = activeGestures.get(layer);
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    const tap = isTapDistance(event.clientX - active.startX, event.clientY - active.startY);
    const shouldClick = !cancelled && !active.longPressed && tap;
    cleanupGesture(layer);
    if (shouldClick) {
      const tab = getPreviewSession(previewState, sessionKey).tabs.find((item) => item.id === tabId);
      if (tab?.content.kind === 'url') postPointerCommand(view, tab.content, 'click');
    }
  };
  layer.addEventListener('pointerup', (event) => finish(event, false));
  layer.addEventListener('pointercancel', (event) => finish(event, true));
}

function ensureRoot(root: HTMLElement): { nav: HTMLElement; body: HTMLElement } {
  if (!root.querySelector('.preview-panel')) {
    root.innerHTML = `
      <div class="preview-panel">
        <nav class="preview-tabs" role="toolbar" aria-label="预览标签"></nav>
        <div class="preview-tab-body"></div>
      </div>
    `;
  }
  return {
    nav: root.querySelector('.preview-tabs') as HTMLElement,
    body: root.querySelector('.preview-tab-body') as HTMLElement,
  };
}

function renderState(): void {
  const root = document.getElementById('panel-root');
  if (!root) return;
  const { nav, body } = ensureRoot(root);
  const sessionKey = previewState.selectedSessionKey;
  const session = getPreviewSession(previewState, sessionKey);
  const dom = sessionDom.get(sessionKey) || new Map<string, TabDom>();
  sessionDom.set(sessionKey, dom);

  nav.hidden = session.tabs.length === 0;
  nav.innerHTML = session.tabs.length > 0
    ? session.tabs.map((tab) => `
      <div class="preview-tab${tab.id === session.activeId ? ' active' : ''}"
        data-preview-tab-id="${escapeHtml(tab.id)}" data-preview-session-key="${escapeHtml(sessionKey)}">
        <button type="button" class="preview-tab-select" aria-pressed="${tab.id === session.activeId}"><span class="preview-tab-label">${escapeHtml(tab.title || '预览')}</span></button>
        <button type="button" class="preview-tab-close" aria-label="关闭 ${escapeHtml(tab.title || '预览')}" data-preview-close-id="${escapeHtml(tab.id)}">×</button>
      </div>
    `).join('')
    : '';
  bindNavigationEvents(nav);

  for (const [key, entries] of sessionDom) {
    const current = getPreviewSession(previewState, key);
    const activeIds = new Set(current.tabs.map((tab) => tab.id));
    for (const [id, item] of entries) {
      if (!activeIds.has(id)) {
        cleanupTabDom(item.view);
        item.view.remove();
        entries.delete(id);
      }
    }
    for (const tab of current.tabs) {
      let item = entries.get(tab.id);
      if (!item) {
        item = { view: document.createElement('section'), content: null };
        item.view.className = 'preview-tab-view';
        item.view.setAttribute('role', 'tabpanel');
        entries.set(tab.id, item);
      }
      item.view.dataset.previewTabId = tab.id;
      item.view.dataset.previewSessionKey = key;
      updateTabDom(key, tab, item);
      if (item.view.parentElement !== body) body.appendChild(item.view);
      item.view.hidden = key !== sessionKey || tab.id !== current.activeId;
      if (!item.view.hidden && tab.content.kind === 'url') layoutWebView(item.view, tab.content);
      if (item.view.hidden) {
        const gesture = item.view.querySelector<HTMLElement>('[data-preview-gesture-layer]');
        if (gesture) cleanupGesture(gesture);
      }
    }
  }

  if (session.tabs.length === 0) {
    let empty = body.querySelector<HTMLElement>('.preview-empty');
    if (!empty) {
      empty = document.createElement('div');
      empty.className = 'preview-empty';
      empty.textContent = '点击消息中的文件链接以预览内容';
      body.appendChild(empty);
    }
  } else {
    body.querySelector('.preview-empty')?.remove();
  }
}

function bindRootEvents(root: HTMLElement): void {
  // The controls bind directly after each render. Keep this marker for host
  // diagnostics, but do not depend on click bubbling through the panel root:
  // some Web hosts wrap or retarget panel events at the document boundary.
  root.dataset.previewEventsBound = 'true';
}

async function loadWebPage(sessionKey: string, tabId: string, href: string, title: string, originalHref = href): Promise<void> {
  const previousTab = getPreviewSession(previewState, sessionKey).tabs.find((tab) => tab.id === tabId);
  if (previousTab?.content.proxySessionId) {
    void ctx?.message.request('preview', 'closeProxyPage', { sessionId: previousTab.content.proxySessionId }).catch(() => undefined);
  }
  const requestId = ++nextRequestId;
  previewState = updatePreviewTab(previewState, sessionKey, tabId, {
    requestId,
    content: { kind: 'url', url: href, title, proxyLoading: true, ...normalizeViewportState() },
  });
  if (previewState.selectedSessionKey === sessionKey) renderState();
  let targetProtocol: string;
  try {
    targetProtocol = new URL(href).protocol;
  } catch {
    updateWebPage(sessionKey, tabId, requestId, { proxyLoading: false, proxyError: '网页地址无效' });
    return;
  }

  let panelProtocol: string;
  try {
    panelProtocol = new URL(window.location.href).protocol;
  } catch {
    panelProtocol = '';
  }
  if (panelProtocol !== 'http:') {
    updateWebPage(sessionKey, tabId, requestId, {
      proxyLoading: false,
      proxyError: 'HTTPS 页面暂不支持本地代理（会产生混合内容）',
    });
  } else if (targetProtocol !== 'http:' && targetProtocol !== 'https:') {
    updateWebPage(sessionKey, tabId, requestId, { proxyLoading: false, proxyError: '仅支持 HTTP(S) 网页代理' });
  } else {
    void openProxyPage(sessionKey, tabId, requestId, href, originalHref, targetProtocol.slice(0, -1));
  }
}

function updateWebPage(sessionKey: string, tabId: string, requestId: number, update: Partial<PreviewContent>): void {
  const tab = getPreviewSession(previewState, sessionKey).tabs.find((item) => item.id === tabId);
  if (!tab || tab.requestId !== requestId || tab.content.kind !== 'url') return;
  previewState = updatePreviewTab(previewState, sessionKey, tabId, {
    content: { ...tab.content, ...update },
  });
  if (previewState.selectedSessionKey === sessionKey) renderState();
}

async function openProxyPage(sessionKey: string, tabId: string, requestId: number, href: string, originalHref: string, protocol: string): Promise<void> {
  let openedSessionId: string | undefined;
  try {
    const result = validateProxySessionResponse(await ctx?.message.request('preview', 'openProxyPage', {
      href,
      originalHref,
      protocol,
      controlOrigin: new URL(window.location.href).origin,
    }));
    openedSessionId = result.sessionId;
    const proxyUrl = buildProxyUrl(result);
    const current = getPreviewSession(previewState, sessionKey).tabs.find((tab) => tab.id === tabId);
    if (!current || current.requestId !== requestId || current.content.kind !== 'url') {
      void ctx?.message.request('preview', 'closeProxyPage', { sessionId: result.sessionId }).catch(() => undefined);
      return;
    }
    updateWebPage(sessionKey, tabId, requestId, {
      proxySessionId: result.sessionId,
      proxyPort: result.port,
      proxyPath: result.path,
      proxyUrl,
      proxyError: undefined,
      proxyLoading: false,
    });
  } catch (err) {
    if (openedSessionId) {
      void ctx?.message.request('preview', 'closeProxyPage', { sessionId: openedSessionId }).catch(() => undefined);
    }
    updateWebPage(sessionKey, tabId, requestId, {
      proxyLoading: false,
      proxyError: err instanceof Error ? err.message : String(err),
    });
  }
}

function selectConversation(data: unknown): void {
  selectionRevision += 1;
  previewState = selectPreviewSession(previewState, previewSessionKey(data));
  renderState();
}

function openTab(sessionKey: string, tab: PreviewTab): { tab: PreviewTab; created: boolean } {
  const result = openPreviewTab(previewState, sessionKey, tab);
  previewState = result.state;
  if (previewState.selectedSessionKey === sessionKey) renderState();
  return { tab: result.tab, created: result.created };
}

function safeResolve(sessionKey: string, tabId: string, requestId: number, content: PreviewContent): void {
  previewState = resolvePreviewTab(previewState, sessionKey, tabId, requestId, content);
  if (previewState.selectedSessionKey === sessionKey) renderState();
}

async function handleLinkClicked(data: unknown): Promise<void> {
  // A link event is user-visible activity. Do not let a stale mount-time
  // conversation getState response replace the session selected by this event.
  selectionRevision += 1;
  const validation = validatePreviewLink(data);
  if ('error' in validation) {
    const sessionKey = previewState.selectedSessionKey;
    const href = validation.originalHref || '预览失败';
    openTab(sessionKey, {
      id: `tab-${++nextTabId}`,
      key: `unsupported:${href}`,
      href,
      originalHref: href,
      title: href,
      content: { kind: 'unsupported', title: href, error: validation.error },
    });
    return;
  }

  const payload = validation.link;
  const sessionKey = payload.conversationId ? `conversation:${payload.conversationId}` : previewState.selectedSessionKey;
  const key = previewKey(payload.protocol, payload.href);
  const isUrl = payload.protocol === 'http' || payload.protocol === 'https';
  const fallbackTitle = payload.text || payload.url.pathname.split('/').pop() || (isUrl ? '链接预览' : '文件');
  const requestId = ++nextRequestId;
  const opened = openTab(sessionKey, {
    id: `tab-${++nextTabId}`,
    key,
    href: payload.href,
    originalHref: payload.originalHref,
    title: fallbackTitle,
    requestId,
    content: isUrl
      ? { kind: 'url', url: payload.href, title: fallbackTitle, proxyLoading: true, ...normalizeViewportState() }
      : { kind: 'file', path: payload.href, title: fallbackTitle },
  });
  if (!opened.created) return;

  if (isUrl) {
    void loadWebPage(sessionKey, opened.tab.id, payload.href, fallbackTitle, payload.originalHref);
    return;
  }

  try {
    const filePayload: PreviewLinkPayload = {
      href: payload.href,
      originalHref: payload.originalHref,
      protocol: payload.protocol,
      ...(payload.text !== undefined ? { text: payload.text } : {}),
      ...(payload.conversationId !== undefined ? { conversationId: payload.conversationId } : {}),
    };
    const result = await ctx?.message.request('preview', 'readFile', filePayload) as PreviewContent;
    if (result) safeResolve(sessionKey, opened.tab.id, requestId, result);
  } catch (err) {
    safeResolve(sessionKey, opened.tab.id, requestId, {
      kind: 'unsupported',
      title: fallbackTitle,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export default {
  async mount(context: PanelContext) {
    const generation = ++mountGeneration;
    const revisionAtStart = selectionRevision;
    ctx = context;
    const root = document.getElementById('panel-root');
    if (root) {
      for (const entries of sessionDom.values()) {
        for (const item of entries.values()) cleanupTabDom(item.view);
      }
      root.innerHTML = '';
      root.dataset.previewEventsBound = '';
      sessionDom.clear();
      bindRootEvents(root);
    }
    renderState();
    void (async () => {
      try {
        const selection = await context.message.request('conversation', 'getState');
        if (generation !== mountGeneration || revisionAtStart !== selectionRevision) return;
        selectConversation(selection);
      } catch {
        // The conversation plugin may not be ready yet; the next broadcast can initialize us.
      }
    })();
  },
  methods: {
    onLinkClicked(data: unknown) {
      void handleLinkClicked(data);
      return data;
    },
    onConversationSelected(data: unknown) {
      selectConversation(data);
      return data;
    },
  },
};
