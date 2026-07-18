const ICONS: Record<string, string> = {
  close: '\u00d7',
  'chevron-down': '\u25be',
  'chevron-right': '\u25b8',
  plus: '+',
  more: '\u22ef',
};

export class IconButton extends HTMLElement {
  static observedAttributes = ['icon', 'size', 'disabled'];

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
    const icon = this.getAttribute('icon') || '';
    const size = this.getAttribute('size') || 'md';
    const disabled = this.hasAttribute('disabled');
    const iconChar = ICONS[icon] || icon;

    this.shadowRoot!.innerHTML = `
      <style>
        button {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: none;
          border: none;
          border-radius: var(--ce-radius-sm, 4px);
          cursor: pointer;
          color: var(--ce-text-secondary, #888);
          transition: color 0.15s, background 0.15s;
        }
        button.sm { width: 20px; height: 20px; font-size: var(--ce-font-xs, 11px); }
        button.md { width: 28px; height: 28px; font-size: var(--ce-font-md, 14px); }
        button:disabled { opacity: 0.4; cursor: not-allowed; }
        button:not(:disabled):hover {
          color: var(--ce-text-primary, #fff);
          background: var(--ce-surface-raised, #2d2d2d);
        }
        slot { display: none; }
      </style>
      <button class="${escapeAttr(size)}" ${disabled ? 'disabled' : ''}>
        ${escapeHtml(iconChar)}
        <slot></slot>
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

customElements.define('ce-icon-button', IconButton);
