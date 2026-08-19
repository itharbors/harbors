import { marked } from 'marked';
import DOMPurify from 'dompurify';

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
    return `<div class="preview-body" style="padding: 0;">
        <iframe class="preview-iframe" src="${escapeHtml(content.url || '')}" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>
      </div>`;
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

function updateTabDom(tab: PreviewTab, dom: TabDom): void {
  if (dom.content === tab.content) return;
  dom.view.innerHTML = contentMarkup(tab.content);
  dom.content = tab.content;
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
        data-preview-tab-id="${escapeHtml(tab.id)}">
        <button type="button" class="preview-tab-select" aria-pressed="${tab.id === session.activeId}"><span class="preview-tab-label">${escapeHtml(tab.title || '预览')}</span></button>
        <button type="button" class="preview-tab-close" aria-label="关闭 ${escapeHtml(tab.title || '预览')}" data-preview-close-id="${escapeHtml(tab.id)}">×</button>
      </div>
    `).join('')
    : '';

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
      updateTabDom(tab, item);
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
  if (root.dataset.previewEventsBound === 'true') return;
  root.dataset.previewEventsBound = 'true';
  const closeTabFromTarget = (target: HTMLElement): boolean => {
    const close = target.closest<HTMLElement>('[data-preview-close-id]');
    const id = close?.dataset.previewCloseId;
    if (!id) return false;
    previewState = closePreviewTab(previewState, previewState.selectedSessionKey, id);
    renderState();
    return true;
  };
  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (closeTabFromTarget(target)) {
      event.stopPropagation();
      return;
    }
    const tab = target.closest<HTMLElement>('[data-preview-tab-id]');
    const id = tab?.dataset.previewTabId;
    if (id) {
      previewState = activatePreviewTab(previewState, previewState.selectedSessionKey, id);
      renderState();
    }
  });
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
  const requestId = isUrl ? undefined : ++nextRequestId;
  const opened = openTab(sessionKey, {
    id: `tab-${++nextTabId}`,
    key,
    href: payload.href,
    originalHref: payload.originalHref,
    title: fallbackTitle,
    requestId,
    content: isUrl
      ? { kind: 'url', url: payload.href, title: fallbackTitle }
      : { kind: 'file', path: payload.href, title: fallbackTitle },
  });
  if (!opened.created || isUrl || requestId === undefined) return;

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
