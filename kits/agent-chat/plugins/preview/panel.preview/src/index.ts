import { marked } from 'marked';
import DOMPurify from 'dompurify';

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
  return DOMPurify.sanitize(marked.parse(content, { async: false }) as string);
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

async function handlePreviewContent(data: unknown): Promise<void> {
  if (!ctx) return;
  const content = data as PreviewContent;

  // 如果是文件但还没有内容，先显示加载中，再请求读取
  if (content.kind === 'file' && content.path && content.content === undefined) {
    renderContent({ ...content, title: content.title || content.path.split('/').pop() });
    try {
      const result = await ctx.message.request('preview', 'readFile', content.path) as PreviewContent;
      renderContent(result);
    } catch (err) {
      renderContent({
        ...content,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    renderContent(content);
  }
}

export default {
  async mount(context: PanelContext) {
    ctx = context;
    renderEmpty();
  },
  methods: {
    onPreviewContent(data: unknown) {
      void handlePreviewContent(data);
      return data;
    },
  },
};
