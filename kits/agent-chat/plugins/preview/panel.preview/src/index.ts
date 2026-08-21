import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { webContentMarkup } from './web-view.js';

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
  snapshotHtml?: string;
  snapshotError?: string;
  mode?: 'direct' | 'snapshot';
  snapshotLoading?: boolean;
  directAllowed?: boolean;
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

export function sanitizeSnapshotHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'base', 'meta', 'form', 'img', 'link', 'audio', 'video', 'source', 'track', 'svg', 'math'],
    FORBID_ATTR: ['srcdoc'],
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });
}

let ctx: PanelContext | null = null;
let previewState: PreviewState = createPreviewState();
let nextTabId = 0;
let nextRequestId = 0;
let mountGeneration = 0;
let selectionRevision = 0;
const sessionDom = new Map<string, Map<string, TabDom>>();

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
    const web = content as WebPageContent;
    const safeHtml = web.snapshotHtml === undefined ? undefined : sanitizeSnapshotHtml(web.snapshotHtml);
    return webContentMarkup({ ...web, snapshotHtml: safeHtml });
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
  dom.view.innerHTML = contentMarkup(tab.content);
  bindWebViewEvents(dom.view, sessionKey, tab.id);
  dom.content = tab.content;
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
  view.querySelectorAll<HTMLElement>('[data-preview-web-mode]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const mode = button.dataset.previewWebMode;
      if (mode !== 'direct' && mode !== 'snapshot') return;
      const tab = getPreviewSession(previewState, sessionKey).tabs.find((item) => item.id === tabId);
      if (tab?.content.kind !== 'url') return;
      previewState = updatePreviewTab(previewState, sessionKey, tabId, {
        content: { ...tab.content, mode },
      });
      renderState();
    });
  });
  view.querySelectorAll<HTMLElement>('[data-preview-web-retry]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const tab = getPreviewSession(previewState, sessionKey).tabs.find((item) => item.id === tabId);
      if (tab?.content.kind === 'url') void loadWebPage(sessionKey, tabId, tab.href, tab.title, tab.originalHref);
    });
  });
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
    content: { kind: 'url', url: href, title, mode: 'direct', proxyLoading: true, snapshotLoading: true },
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
  // Snapshot fetching is deliberately independent: a slow/failed snapshot must
  // never delay the proxy iframe becoming available.
  void loadSnapshot(sessionKey, tabId, requestId, href, originalHref);
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
      mode: 'direct',
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

async function loadSnapshot(sessionKey: string, tabId: string, requestId: number, href: string, originalHref: string): Promise<void> {
  try {
    const result = await ctx?.message.request('preview', 'fetchWebPage', {
      href,
      originalHref,
      protocol: new URL(href).protocol.slice(0, -1),
    }) as WebPageContent;
    if (result) {
      updateWebPage(sessionKey, tabId, requestId, {
        snapshotHtml: result.snapshotHtml,
        snapshotError: result.snapshotError,
        snapshotLoading: false,
      });
    }
  } catch (err) {
    updateWebPage(sessionKey, tabId, requestId, {
      snapshotLoading: false,
      snapshotError: err instanceof Error ? err.message : String(err),
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
      ? { kind: 'url', url: payload.href, title: fallbackTitle, mode: 'direct', proxyLoading: true, snapshotLoading: true }
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
