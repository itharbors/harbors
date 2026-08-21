export interface WebViewContent {
  url?: string;
  title?: string;
  snapshotHtml?: string;
  snapshotError?: string;
  mode?: 'direct' | 'snapshot';
  snapshotLoading?: boolean;
  directAllowed?: boolean;
  proxySessionId?: string;
  proxyPort?: number;
  proxyPath?: string;
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

export function webContentMarkup(content: WebViewContent): string {
  const hasSnapshot = content.snapshotHtml !== undefined;
  const mode = content.mode || 'direct';
  const snapshotDocument = hasSnapshot
    ? '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"></head><body>'
      + `${content.snapshotHtml || ''}</body></html>`
    : '';
  const proxyUrl = content.proxyUrl;
  const legacyDirectUrl = !proxyUrl && content.directAllowed === true ? content.url : undefined;
  const frame = mode === 'snapshot' && hasSnapshot
      ? `<iframe class="preview-iframe" title="网页安全快照" srcdoc="${escapeMarkup(snapshotDocument)}" sandbox="" referrerpolicy="no-referrer"></iframe>`
      : proxyUrl
        ? `<iframe class="preview-iframe" title="代理网页" src="${escapeMarkup(proxyUrl)}" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>`
        : legacyDirectUrl
          ? `<iframe class="preview-iframe" title="网页直连" src="${escapeMarkup(legacyDirectUrl)}" sandbox="" referrerpolicy="no-referrer"></iframe>`
        : content.proxyLoading
          ? '<div class="preview-loading">正在启动代理…</div>'
          : `<div class="preview-error">${escapeMarkup(content.proxyError || '代理不可用，且已阻止不受限网页直连')}</div>`;
  const status = content.proxyLoading
    ? '<span class="preview-web-status">正在启动代理…</span>'
      : content.proxyError
      ? `<span class="preview-web-status preview-web-status-error">代理失败：${escapeMarkup(content.proxyError)}</span>`
      : content.snapshotError
        ? `<span class="preview-web-status preview-web-status-error">安全快照不可用：${escapeMarkup(content.snapshotError)}</span>`
        : mode === 'snapshot' && hasSnapshot
          ? '<span class="preview-web-status">安全快照模式；脚本、登录和表单交互已禁用</span>'
          : proxyUrl
            ? '<span class="preview-web-status">代理网页已加载；首版限制登录、表单和部分交互</span>'
        : !proxyUrl && content.directAllowed === true
          ? '<span class="preview-web-status">网页直连可能受目标站点嵌入策略限制</span>'
          : '<span class="preview-web-status">网页可能拒绝嵌入或存在资源兼容性问题</span>';
  return `<div class="preview-web">
      <div class="preview-web-toolbar">
        ${status}
        <button type="button" data-preview-web-mode="direct" ${!proxyUrl || mode === 'direct' ? 'disabled' : ''}>代理网页</button>
        <button type="button" data-preview-web-mode="snapshot" ${!hasSnapshot || mode === 'snapshot' ? 'disabled' : ''}>安全快照</button>
        <button type="button" data-preview-web-retry="true">重试快照</button>
      </div>
      <div class="preview-body preview-web-body">${frame}</div>
    </div>`;
}
