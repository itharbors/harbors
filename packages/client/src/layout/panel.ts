import { i18nStore } from '../i18n/store';

export class Panel extends HTMLElement {
  static observedAttributes = ['src', 'chromeless', 'type', 'title-i18n', 'aria-label-i18n'];

  private disposeI18n: (() => void) | null = null;

  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
    }
    this.disposeI18n = i18nStore.subscribe((event) => {
      const titleKey = this.getAttribute('title-i18n') || '';
      const ariaKey = this.getAttribute('aria-label-i18n') || '';
      if (
        event.type === 'locale-changed'
        || event.changedKeys.includes(titleKey)
        || event.changedKeys.includes(ariaKey)
      ) {
        // i18n 变化只刷新文本属性，避免重建 shadow DOM 里的 iframe，让面板内容保持热更新。
        this.syncI18nAttributes();
      }
    });
    this.syncI18nAttributes();
    this.render();
  }

  disconnectedCallback() {
    this.disposeI18n?.();
    this.disposeI18n = null;
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null) {
    if (!this.shadowRoot || oldValue === newValue) {
      return;
    }

    // 只有影响 shadow DOM 结构的属性才重新渲染；i18n 文本类属性走 syncI18nAttributes 即可。
    if (name === 'title-i18n' || name === 'aria-label-i18n') {
      this.syncI18nAttributes();
      return;
    }

    this.syncI18nAttributes();
    this.render();
  }

  private syncI18nAttributes() {
    const titleKey = this.getAttribute('title-i18n');
    if (titleKey) {
      this.setAttribute('title', i18nStore.t(titleKey));
    }
    const ariaKey = this.getAttribute('aria-label-i18n');
    if (ariaKey) {
      this.setAttribute('aria-label', i18nStore.t(ariaKey));
    }
  }

  private render() {
    const src = this.getAttribute('src');
    const type = this.getAttribute('type') || 'iframe';
    const isSimple = type === 'simple';
    const shouldRenderIframe = Boolean(src);
    const chromeless = this.hasAttribute('chromeless') || isSimple;

    this.shadowRoot!.innerHTML = `
      <style>
        :host {
          display: flex;
          flex: 1;
          flex-direction: column;
          min-width: var(--layout-min-width, var(--panel-min-width, var(--panel-min-size, 100px)));
          max-width: var(--panel-max-size, none);
          min-height: var(--layout-min-height, var(--panel-min-height, var(--panel-min-size, 100px)));
          max-height: var(--panel-max-size, none);
          overflow: hidden;
          background: var(--ce-panel-bg, var(--ce-surface, #1a1a1a));
          border: var(--ce-panel-border-width, 1px) solid var(--ce-panel-border-color, var(--ce-border, #444));
          border-radius: var(--ce-panel-radius, var(--ce-radius-sm, 4px));
        }
        :host([chromeless]) {
          min-width: 0;
          min-height: 0;
          background: transparent;
          border: 0;
          border-radius: 0;
        }
        :host([type="simple"]) {
          min-width: 0;
          min-height: 0;
          background: transparent;
          border: 0;
          border-radius: 0;
        }
        .header {
          display: flex;
          align-items: center;
          flex-shrink: 0;
          height: var(--panel-header-height, 28px);
          padding: 0 var(--ce-space-2, 8px);
          gap: var(--ce-space-1, 4px);
          color: var(--ce-text-secondary, #888);
          background: var(--ce-panel-header-bg, var(--ce-surface-raised, #2d2d2d));
          border-bottom: var(--ce-panel-header-border-width, 1px) solid var(--ce-panel-header-border-color, var(--ce-border, #444));
          font-size: var(--ce-font-xs, 11px);
        }
        .header slot {
          flex: 1;
          min-width: 0;
          overflow: hidden;
        }
        .content {
          display: flex;
          flex: 1;
          min-width: 0;
          min-height: 0;
          overflow: hidden;
          background: var(--ce-panel-content-bg, var(--ce-surface, #1a1a1a));
        }
        .content slot {
          display: flex;
          flex: 1;
          min-width: 0;
          min-height: 0;
          overflow: hidden;
        }
        iframe {
          width: 100%;
          height: 100%;
          min-width: 0;
          min-height: 0;
          border: 0;
          background: transparent;
        }
        :host([type="simple"]) .content {
          background: transparent;
        }
        :host([chromeless]) .content {
          background: transparent;
        }
      </style>
      ${chromeless ? '' : `
        <div class="header">
          <slot name="header">Panel</slot>
        </div>
      `}
      <div class="content">
        ${shouldRenderIframe ? `<iframe src="${escapeAttr(src!)}" sandbox="allow-scripts allow-same-origin" allowtransparency="true"></iframe>` : '<slot></slot>'}
      </div>
    `;
    this.syncIframeTransparency();
  }

  private syncIframeTransparency(): void {
    const iframe = this.shadowRoot!.querySelector('iframe');
    if (!iframe) return;

    iframe.style.background = 'transparent';
    iframe.style.backgroundColor = 'transparent';

    const apply = () => {
      try {
        const doc = iframe.contentDocument;
        if (!doc) return;

        doc.documentElement.style.background = 'transparent';
        doc.documentElement.style.backgroundColor = 'transparent';
        doc.body?.style.setProperty('background', 'transparent', 'important');
        doc.body?.style.setProperty('background-color', 'transparent', 'important');

        let style = doc.getElementById('ce-panel-transparent-frame') as HTMLStyleElement | null;
        if (!style) {
          style = doc.createElement('style');
          style.id = 'ce-panel-transparent-frame';
          doc.head.appendChild(style);
        }
        style.textContent = `
          html,
          body {
            background: transparent !important;
            background-color: transparent !important;
          }
        `;
      } catch {
        // Cross-origin frames cannot be patched; same-origin panel iframes are patched on load.
      }
    };

    iframe.addEventListener('load', apply);
    apply();
  }
}

if (!customElements.get('ce-panel')) {
  customElements.define('ce-panel', Panel);
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
