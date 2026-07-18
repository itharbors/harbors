export class Textarea extends HTMLElement {
  static observedAttributes = ['value', 'placeholder', 'rows', 'disabled', 'readonly'];

  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
    }
    this.render();
    this.setupEvents();
  }

  attributeChangedCallback(name: string, _oldVal: string | null, newVal: string | null) {
    if (!this.shadowRoot) return;
    const ta = this.shadowRoot.querySelector('textarea');
    if (!ta) return;

    if (name === 'value') ta.value = newVal || '';
    else if (name === 'disabled') ta.disabled = newVal !== null;
    else if (name === 'readonly') ta.readOnly = newVal !== null;
    else if (name === 'rows') ta.rows = parseInt(newVal || '4', 10);
    else if (name === 'placeholder') ta.placeholder = newVal || '';
  }

  private render() {
    const value = this.getAttribute('value') || '';
    const placeholder = this.getAttribute('placeholder') || '';
    const rows = this.getAttribute('rows') || '4';
    const disabled = this.hasAttribute('disabled');
    const readonly = this.hasAttribute('readonly');

    this.shadowRoot!.innerHTML = `
      <style>
        :host { display: inline-block; }
        textarea {
          padding: var(--ce-space-2, 8px);
          background: var(--ce-input-bg, var(--ce-surface, #1a1a1a));
          border: 1px solid var(--ce-input-border, var(--ce-border, #444));
          border-radius: var(--ce-radius-sm, 4px);
          color: var(--ce-input-fg, var(--ce-text-primary, #fff));
          font-size: var(--ce-font-sm, 12px);
          font-family: monospace;
          outline: none;
          resize: vertical;
          box-sizing: border-box;
          width: 100%;
        }
        textarea:focus-visible {
          outline: 2px solid var(--ce-input-focus-ring, var(--ce-focus-ring, var(--ce-accent, #569cd6)));
          outline-offset: 1px;
        }
        textarea:disabled {
          background: var(--ce-input-disabled-bg, var(--ce-input-bg, var(--ce-surface, #1a1a1a)));
          border-color: var(--ce-input-disabled-border, var(--ce-input-border, var(--ce-border, #444)));
          color: var(--ce-input-disabled-fg, var(--ce-input-fg, var(--ce-text-primary, #fff)));
          cursor: not-allowed;
        }
        textarea::placeholder { color: var(--ce-input-placeholder, var(--ce-text-muted, #444)); }
      </style>
      <textarea rows="${escapeAttr(rows)}" placeholder="${escapeAttr(placeholder)}"
        ${disabled ? 'disabled' : ''} ${readonly ? 'readonly' : ''}>${escapeHtml(value)}</textarea>
    `;
  }

  private setupEvents() {
    const ta = this.shadowRoot!.querySelector('textarea')!;
    ta.addEventListener('input', () => {
      this.dispatchEvent(new CustomEvent('ce-input', {
        detail: { value: ta.value },
        bubbles: true,
        composed: true,
      }));
    });
    ta.addEventListener('change', () => {
      this.setAttribute('value', ta.value);
      this.dispatchEvent(new CustomEvent('ce-change', {
        detail: { value: ta.value },
        bubbles: true,
        composed: true,
      }));
    });
  }
}

function escapeAttr(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

customElements.define('ce-textarea', Textarea);
