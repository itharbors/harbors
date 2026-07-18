import { i18nStore } from '../i18n/store';

export class ContextMenu extends HTMLElement {
  static observedAttributes = ['open', 'x', 'y', 'title-i18n', 'aria-label-i18n'];

  private disposeI18n: (() => void) | null = null;

  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
    }
    this.disposeI18n = i18nStore.subscribe((event) => {
      const titleKey = this.getAttribute('title-i18n') || '';
      const ariaKey = this.getAttribute('aria-label-i18n') || '';
      const itemKeys = Array.from(this.querySelectorAll('[data-i18n]'))
        .map((item) => item.getAttribute('data-i18n') || '');
      if (
        event.type === 'locale-changed'
        || event.changedKeys.includes(titleKey)
        || event.changedKeys.includes(ariaKey)
        || itemKeys.some((key) => event.changedKeys.includes(key))
      ) {
        this.syncI18nAttributes();
        this.render();
      }
    });
    this.syncI18nAttributes();
    this.render();
  }

  disconnectedCallback() {
    this.disposeI18n?.();
    this.disposeI18n = null;
  }

  attributeChangedCallback() {
    if (this.shadowRoot) {
      this.render();
    }
  }

  private render() {
    if (!this.hasAttribute('open')) {
      this.shadowRoot!.innerHTML = '<style>:host { display: none; }</style>';
      return;
    }

    const x = this.getCoordinate('x');
    const y = this.getCoordinate('y');
    const itemEls = Array.from(this.querySelectorAll('[data-action]'))
      .map((item) => {
        const action = item.getAttribute('data-action') || '';
        const key = item.getAttribute('data-i18n');
        const text = key ? i18nStore.t(key) : (item.textContent || action);
        return `<div class="menu-item" data-action="${escapeAttr(action)}">${escapeHtml(text)}</div>`;
      })
      .join('');

    this.shadowRoot!.innerHTML = `
      <style>
        .backdrop {
          position: fixed;
          inset: 0;
          z-index: 10000;
        }
        .menu {
          position: fixed;
          z-index: 10001;
          min-width: 140px;
          padding: var(--ce-space-1, 4px) 0;
          background: var(--ce-surface, #1a1a1a);
          border: 1px solid var(--ce-border, #444);
          border-radius: var(--ce-radius-sm, 4px);
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
        }
        .menu-item {
          padding: var(--ce-space-1, 4px) var(--ce-space-3, 12px);
          color: var(--ce-text-primary, #fff);
          font-size: var(--ce-font-sm, 12px);
          cursor: pointer;
        }
        .menu-item:hover {
          background: var(--ce-accent, #569cd6);
        }
      </style>
      <div class="backdrop"></div>
      <div class="menu" style="left: ${x}px; top: ${y}px;">${itemEls}</div>
    `;

    this.shadowRoot!.querySelector('.backdrop')!.addEventListener('click', () => this.close());
    this.shadowRoot!.querySelector('.backdrop')!.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.close();
    });

    this.shadowRoot!.querySelectorAll('.menu-item').forEach((item) => {
      item.addEventListener('click', () => {
        const action = item.getAttribute('data-action') || '';
        this.dispatchEvent(new CustomEvent('ce-context-action', {
          detail: { action },
          bubbles: true,
          composed: true,
        }));
        this.close();
      });
    });
  }

  private getCoordinate(name: 'x' | 'y') {
    const parsed = Number.parseInt(this.getAttribute(name) || '0', 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  private close() {
    this.removeAttribute('open');
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
}

if (!customElements.get('ce-context-menu')) {
  customElements.define('ce-context-menu', ContextMenu);
}

function escapeAttr(value: string) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
