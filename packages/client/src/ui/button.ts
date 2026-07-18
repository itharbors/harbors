export class Button extends HTMLElement {
  static observedAttributes = ['variant', 'size', 'disabled'];

  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
    }
    this.render();
  }

  attributeChangedCallback() {
    if (this.shadowRoot) this.render();
  }

  private render() {
    const variant = normalizeButtonVariant(this.getAttribute('variant'));
    const size = normalizeButtonSize(this.getAttribute('size'));
    const disabled = this.hasAttribute('disabled');
    const fallbackText = this.textContent || '';

    this.shadowRoot!.innerHTML = `
      <style>
        button {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 1px solid var(--ce-button-border, var(--ce-border, #444));
          border-radius: var(--ce-radius-sm, 4px);
          cursor: pointer;
          font-family: inherit;
          transition: background 0.15s, border-color 0.15s, color 0.15s, outline-color 0.15s;
          color: var(--ce-button-fg, var(--ce-text-primary, #fff));
          background: var(--ce-button-bg, var(--ce-surface-raised, #2d2d2d));
          padding: 0 var(--ce-space-3, 12px);
        }
        button.primary {
          background: var(--ce-accent, #569cd6);
          border-color: var(--ce-accent, #569cd6);
          color: #fff;
        }
        button.ghost {
          background: transparent;
          border-color: transparent;
          color: var(--ce-text-secondary, #888);
        }
        button.ghost:hover {
          color: var(--ce-button-fg, var(--ce-text-primary, #fff));
          background: var(--ce-button-bg-hover, var(--ce-surface-hover, #353b45));
        }
        button.danger {
          background: var(--ce-danger, #f44747);
          border-color: var(--ce-danger, #f44747);
          color: #fff;
        }
        button.sm {
          height: 24px;
          font-size: var(--ce-font-xs, 11px);
          padding: 0 var(--ce-space-2, 8px);
        }
        button.md {
          height: 30px;
          font-size: var(--ce-font-sm, 12px);
        }
        button:focus-visible {
          outline: 2px solid var(--ce-button-focus-ring, var(--ce-focus-ring, var(--ce-accent, #569cd6)));
          outline-offset: 2px;
        }
        button:disabled {
          color: var(--ce-button-disabled-fg, var(--ce-text-muted, #666d79));
          background: var(--ce-button-disabled-bg, #15181d);
          border-color: var(--ce-button-disabled-border, #2b313c);
          cursor: not-allowed;
        }
        button:not(:disabled):hover {
          background: var(--ce-button-bg-hover, var(--ce-surface-hover, #353b45));
        }
        button:not(:disabled):active {
          background: var(--ce-button-bg-active, var(--ce-surface-active, #232934));
        }
      </style>
      <button class="${escapeAttr(variant)} ${escapeAttr(size)}" ${disabled ? 'disabled' : ''}>
        <slot>${escapeHtml(fallbackText)}</slot>
      </button>
    `;
  }
}

function escapeAttr(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function normalizeButtonVariant(value: string | null): 'secondary' | 'primary' | 'ghost' | 'danger' {
  if (value === 'primary' || value === 'ghost' || value === 'danger') {
    return value;
  }
  return 'secondary';
}

function normalizeButtonSize(value: string | null): 'sm' | 'md' {
  if (value === 'sm') {
    return value;
  }
  return 'md';
}

if (!customElements.get('ce-button')) {
  customElements.define('ce-button', Button);
}
