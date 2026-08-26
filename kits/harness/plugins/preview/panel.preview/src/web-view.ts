import { normalizeViewportState, type ViewportState } from './viewport.js';

export interface WebViewContent extends Partial<ViewportState> {
  url?: string;
  title?: string;
  proxySessionId?: string;
  proxyUrl?: string;
  proxyError?: string;
  proxyLoading?: boolean;
}

function escapeMarkup(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] || character);
}

function gestureMarkup(state: ViewportState): string {
  if (state.interactionMode !== 'virtual') return '';
  return `<div class="preview-gesture-layer" data-preview-gesture-layer="true" tabindex="0" role="application" aria-label="模拟鼠标手势区；滑动移动，轻点左键，长按右键">
    <div class="preview-virtual-cursor" data-preview-virtual-cursor="true" aria-hidden="true"><span>虚拟鼠标</span></div>
  </div>`;
}

function statusMarkup(content: WebViewContent): string {
  if (content.proxyLoading) return '<span class="preview-web-status">正在启动代理…</span>';
  if (content.proxyError) return `<span class="preview-web-status preview-web-status-error">代理失败：${escapeMarkup(content.proxyError)}</span>`;
  return '<span class="preview-web-status">受限网页已加载；登录、表单和部分交互仍受限制</span>';
}

function canvasMarkup(content: WebViewContent, state: ViewportState): string {
  if (!content.proxyUrl) {
    return content.proxyLoading
      ? '<div class="preview-loading">正在启动代理…</div>'
      : `<div class="preview-error">${escapeMarkup(content.proxyError || '代理不可用，已阻止不受限网页直连')}</div>`;
  }
  return `<div class="preview-web-clip" data-preview-web-clip="true">
    <div class="preview-web-canvas" data-preview-web-canvas="true" style="width:${state.viewportWidth}px;height:${state.viewportHeight}px">
      <iframe class="preview-iframe" title="受限网页" src="${escapeMarkup(content.proxyUrl)}" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
    </div>
    ${gestureMarkup(state)}
  </div>`;
}

export function webContentMarkup(content: WebViewContent): string {
  const state = normalizeViewportState(content);
  return `<div class="preview-web" data-preview-proxy-url="${escapeMarkup(content.proxyUrl || '')}">
    <div class="preview-web-controls" aria-label="网页视口控制">
      ${statusMarkup(content)}
      <label>宽 <input type="number" data-preview-viewport-width="true" min="320" max="3840" step="1" value="${state.viewportWidth}"></label>
      <label>高 <input type="number" data-preview-viewport-height="true" min="240" max="2160" step="1" value="${state.viewportHeight}"></label>
      <div class="preview-interaction-switch" role="group" aria-label="网页交互模式">
        <button type="button" data-preview-interaction-mode="direct" aria-pressed="${state.interactionMode === 'direct'}">直接交互</button>
        <button type="button" data-preview-interaction-mode="virtual" aria-pressed="${state.interactionMode === 'virtual'}">模拟鼠标</button>
      </div>
    </div>
    <div class="preview-body preview-web-body">${canvasMarkup(content, state)}</div>
  </div>`;
}

export function syncWebContent(view: HTMLElement, content: WebViewContent): boolean {
  const web = view.querySelector<HTMLElement>('.preview-web');
  const frame = web?.querySelector<HTMLIFrameElement>('.preview-iframe');
  if (!web || !frame || !content.proxyUrl || web.dataset.previewProxyUrl !== content.proxyUrl) return false;
  const state = normalizeViewportState(content);
  const canvas = web.querySelector<HTMLElement>('[data-preview-web-canvas]');
  const clip = web.querySelector<HTMLElement>('[data-preview-web-clip]');
  if (!canvas || !clip) return false;
  canvas.style.width = `${state.viewportWidth}px`;
  canvas.style.height = `${state.viewportHeight}px`;
  const width = web.querySelector<HTMLInputElement>('[data-preview-viewport-width]');
  const height = web.querySelector<HTMLInputElement>('[data-preview-viewport-height]');
  if (width) width.value = String(state.viewportWidth);
  if (height) height.value = String(state.viewportHeight);
  web.querySelectorAll<HTMLButtonElement>('[data-preview-interaction-mode]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.previewInteractionMode === state.interactionMode));
  });
  const existingGesture = clip.querySelector<HTMLElement>('[data-preview-gesture-layer]');
  if (state.interactionMode === 'virtual' && !existingGesture) clip.insertAdjacentHTML('beforeend', gestureMarkup(state));
  else if (state.interactionMode === 'direct') existingGesture?.remove();
  return true;
}
