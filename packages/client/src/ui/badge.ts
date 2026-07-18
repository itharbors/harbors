export class Badge extends HTMLElement {
  static observedAttributes = ['variant'];

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
    const variant = this.getAttribute('variant') || 'info';

    this.shadowRoot!.innerHTML = `
      <style>
        span {
          display: inline-block;
          padding: 1px 6px;
          border-radius: 10px;
          font-size: var(--ce-font-xs, 11px);
          font-weight: 600;
          text-transform: uppercase;
        }
        span.info { background: var(--ce-accent, #569cd6); color: #fff; }
        span.success { background: var(--ce-success, #4ec9b0); color: #000; }
        span.warning { background: var(--ce-orange, #ce9178); color: #000; }
        span.danger { background: var(--ce-danger, #f44747); color: #fff; }
      </style>
      <span class="${escapeAttr(variant)}"><slot></slot></span>
    `;
  }
}

if (!customElements.get('ce-badge')) {
  customElements.define('ce-badge', Badge);
}

function escapeAttr(value: string) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
