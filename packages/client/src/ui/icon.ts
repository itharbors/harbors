const ICONS: Record<string, string> = {
  close: '\u00d7',
  'chevron-down': '\u25be',
  'chevron-right': '\u25b8',
  plus: '+',
  more: '\u22ef',
  search: '\u2315',
  folder: '\ud83d\udcc1',
  file: '\ud83d\udcc4',
};

export class Icon extends HTMLElement {
  static observedAttributes = ['name', 'size'];

  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
    }
    this.render();
  }

  attributeChangedCallback() {
    if (this.shadowRoot) {
      this.render();
    }
  }

  private render() {
    const name = this.getAttribute('name') || '';
    const size = this.getAttribute('size') || 'md';
    const iconChar = ICONS[name] || name;

    this.shadowRoot!.innerHTML = `
      <style>
        :host {
          display: inline-flex;
          align-items: center;
        }
        span {
          display: inline-block;
          line-height: 1;
        }
        span.sm { font-size: var(--ce-font-xs, 11px); }
        span.md { font-size: var(--ce-font-md, 14px); }
        span.lg { font-size: var(--ce-font-lg, 16px); }
      </style>
      <span class="${escapeAttr(size)}">${escapeHtml(iconChar)}</span>
    `;
  }
}

if (!customElements.get('ce-icon')) {
  customElements.define('ce-icon', Icon);
}

function escapeAttr(value: string) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
