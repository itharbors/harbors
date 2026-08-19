import { marked } from 'marked';
import DOMPurify from 'dompurify';

import { validatePreviewLink, type PreviewLinkPayload } from './uri.js';

marked.setOptions({ gfm: true, breaks: true });

interface PreviewContent {
  kind: 'file' | 'url' | 'unsupported';
  path?: string;
  url?: string;
  title?: string;
  language?: string;
  content?: string;
  error?: string;
}

interface PanelContext {
  message: {
    request(plugin: string, name: string, ...args: unknown[]): Promise<unknown>;
  };
}

let ctx: PanelContext | null = null;

function renderMarkdown(content: string): string {
  try {
    const html = marked.parse(content, { async: false });
    return DOMPurify.sanitize(typeof html === 'string' ? html : String(html));
  } catch {
    // 渲染失败时降级为纯文本展示，避免面板白屏
    return `<pre class="preview-code"><code>${escapeHtml(content)}</code></pre>`;
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderContent(content: PreviewContent): void {
  const root = document.getElementById('panel-root');
  if (!root) return;

  if (content.error) {
    root.innerHTML = `
      <div class="preview-panel">
        <header class="preview-header">
          <span class="preview-title">${content.title || '预览'}</span>
        </header>
        <div class="preview-body">
          <div class="preview-error">${escapeHtml(content.error)}</div>
        </div>
      </div>
    `;
    return;
  }

  if (content.kind === 'url') {
    root.innerHTML = `
      <div class="preview-panel">
        <header class="preview-header">
          <span class="preview-title">${escapeHtml(content.title || '链接预览')}</span>
          <span class="preview-path">${escapeHtml(content.url || '')}</span>
        </header>
        <div class="preview-body" style="padding: 0;">
          <iframe class="preview-iframe" src="${escapeHtml(content.url || '')}" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>
        </div>
      </div>
    `;
    return;
  }

  if (content.kind === 'file' && content.language === 'image') {
    root.innerHTML = `
      <div class="preview-panel">
        <header class="preview-header">
          <span class="preview-title">${escapeHtml(content.title || '图片')}</span>
          <span class="preview-path">${escapeHtml(content.path || '')}</span>
        </header>
        <div class="preview-body">
          <img class="preview-image" src="${content.content}" alt="${escapeHtml(content.title || '')}" />
        </div>
      </div>
    `;
    return;
  }

  if (content.kind === 'file' && content.content !== undefined) {
    const isMarkdown = content.language === 'markdown';
    const body = isMarkdown
      ? `<div class="preview-markdown">${renderMarkdown(content.content)}</div>`
      : `<pre class="preview-code"><code>${escapeHtml(content.content)}</code></pre>`;

    root.innerHTML = `
      <div class="preview-panel">
        <header class="preview-header">
          <span class="preview-title">${escapeHtml(content.title || '文件')}</span>
          <span class="preview-path">${escapeHtml(content.path || '')}</span>
        </header>
        <div class="preview-body">
          ${body}
        </div>
      </div>
    `;
    return;
  }

  if (content.kind === 'unsupported') {
    root.innerHTML = `
      <div class="preview-panel">
        <header class="preview-header">
          <span class="preview-title">${escapeHtml(content.title || '不支持的类型')}</span>
        </header>
        <div class="preview-body">
          <div class="preview-error">${escapeHtml(content.error || '不支持预览此类型的内容')}</div>
        </div>
      </div>
    `;
    return;
  }

  // 加载中
  root.innerHTML = `
    <div class="preview-panel">
      <header class="preview-header">
        <span class="preview-title">${escapeHtml(content.title || '加载中…')}</span>
      </header>
      <div class="preview-body">
        <div class="preview-loading">正在加载…</div>
      </div>
    </div>
  `;
}

function renderEmpty(): void {
  const root = document.getElementById('panel-root');
  if (!root) return;
  root.innerHTML = `
    <div class="preview-panel">
      <header class="preview-header">
        <span class="preview-title">预览</span>
      </header>
      <div class="preview-body">
        <div class="preview-empty">点击消息中的文件链接以预览内容</div>
      </div>
    </div>
  `;
}

function safeRenderContent(content: PreviewContent): void {
  try {
    renderContent(content);
  } catch (err) {
    renderContent({
      kind: 'unsupported',
      title: content.title || '预览失败',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleLinkClicked(data: unknown): Promise<void> {
  if (!ctx) return;
  const validation = validatePreviewLink(data);
  if ('error' in validation) {
    safeRenderContent({
      kind: 'unsupported',
      title: validation.originalHref || '预览失败',
      error: validation.error,
    });
    return;
  }
  const payload = validation.link;

  if (payload.protocol === 'http' || payload.protocol === 'https') {
    safeRenderContent({
      kind: 'url',
      url: payload.href,
      title: payload.text || payload.href,
    });
    return;
  }

  // 文件：先显示加载中，再主动向自己后端请求内容
  const fallbackTitle = payload.text || payload.url.pathname.split('/').pop() || '文件';
  safeRenderContent({ kind: 'file', path: payload.href, title: fallbackTitle });
  try {
    // URL 仅是本地校验结果，不跨消息边界传递；请求 payload 保持规范字段。
    const filePayload: PreviewLinkPayload = {
      href: payload.href,
      originalHref: payload.originalHref,
      protocol: payload.protocol,
      ...(payload.text !== undefined ? { text: payload.text } : {}),
      ...(payload.conversationId !== undefined ? { conversationId: payload.conversationId } : {}),
    };
    const result = await ctx.message.request(
      'preview',
      'readFile',
      filePayload,
    ) as PreviewContent;
    safeRenderContent(result);
  } catch (err) {
    safeRenderContent({
      kind: 'unsupported',
      title: fallbackTitle,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export default {
  async mount(context: PanelContext) {
    ctx = context;
    renderEmpty();
  },
  methods: {
    onLinkClicked(data: unknown) {
      void handleLinkClicked(data);
      return data;
    },
  },
};
