export class Dialog extends HTMLElement {
  static observedAttributes = ['open', 'closable'];

  get open() {
    return this.hasAttribute('open');
  }

  set open(value: boolean) {
    if (value) {
      this.setAttribute('open', '');
    } else {
      this.removeAttribute('open');
    }
  }

  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
    }
    this.render();
  }

  attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null) {
    if (!this.shadowRoot) return;

    this.render();

    if (name === 'open') {
      const eventName = newValue === null ? 'ce-dialog-close' : 'ce-dialog-open';
      this.dispatchEvent(new CustomEvent(eventName, { bubbles: true, composed: true }));
    }
  }

  private render() {
    if (!this.open) {
      this.shadowRoot!.innerHTML = '<style>:host { display: none; }</style>';
      return;
    }

    this.shadowRoot!.innerHTML = `
      <style>
        .backdrop {
          position: fixed;
          inset: 0;
          z-index: 9999;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(0, 0, 0, 0.5);
        }
        .dialog {
          min-width: 300px;
          max-width: 90vw;
          color: var(--ce-text-primary, #fff);
          background: var(--ce-surface, #1a1a1a);
          border: 1px solid var(--ce-border, #444);
          border-radius: var(--ce-radius-md, 8px);
          box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5);
        }
        .dialog-header {
          padding: var(--ce-space-3, 12px) var(--ce-space-4, 16px);
          border-bottom: 1px solid var(--ce-border, #444);
          font-size: var(--ce-font-md, 14px);
          font-weight: 600;
        }
        .dialog-body {
          padding: var(--ce-space-4, 16px);
          font-size: var(--ce-font-sm, 12px);
        }
        .dialog-footer {
          display: flex;
          justify-content: flex-end;
          gap: var(--ce-space-2, 8px);
          padding: var(--ce-space-3, 12px) var(--ce-space-4, 16px);
          border-top: 1px solid var(--ce-border, #444);
        }
      </style>
      <div class="backdrop">
        <div class="dialog" role="dialog" aria-modal="true">
          <div class="dialog-header"><slot name="header"></slot></div>
          <div class="dialog-body"><slot name="body"></slot></div>
          <div class="dialog-footer"><slot name="footer"></slot></div>
        </div>
      </div>
    `;

    if (this.getAttribute('closable') !== 'false') {
      const backdrop = this.shadowRoot!.querySelector('.backdrop')!;
      backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop) {
          this.open = false;
        }
      });
    }
  }
}

if (!customElements.get('ce-dialog')) {
  customElements.define('ce-dialog', Dialog);
}
