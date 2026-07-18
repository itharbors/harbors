export class Input extends HTMLElement {
  static observedAttributes = ['value', 'placeholder', 'type', 'disabled', 'readonly'];

  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
    }
    this.render();
    this.setupEvents();
  }

  attributeChangedCallback(name: string, _oldVal: string | null, newVal: string | null) {
    if (!this.shadowRoot) return;
    const input = this.shadowRoot.querySelector('input');
    if (!input) return;

    if (name === 'value') input.value = newVal || '';
    else if (name === 'disabled') input.disabled = newVal !== null;
    else if (name === 'readonly') input.readOnly = newVal !== null;
    else if (name === 'placeholder') input.placeholder = newVal || '';
    else if (name === 'type') input.type = newVal || 'text';
  }

  private render() {
    const value = this.getAttribute('value') || '';
    const placeholder = this.getAttribute('placeholder') || '';
    const type = this.getAttribute('type') || 'text';
    const disabled = this.hasAttribute('disabled');
    const readonly = this.hasAttribute('readonly');

    this.shadowRoot!.innerHTML = `
      <style>
        :host { display: inline-block; }
        input {
          height: 30px;
          padding: 0 var(--ce-space-2, 8px);
          background: var(--ce-input-bg, var(--ce-surface, #1a1a1a));
          border: 1px solid var(--ce-input-border, var(--ce-border, #444));
          border-radius: var(--ce-radius-sm, 4px);
          color: var(--ce-input-fg, var(--ce-text-primary, #fff));
          font-size: var(--ce-font-sm, 12px);
          font-family: inherit;
          outline: none;
          box-sizing: border-box;
          width: 100%;
        }
        input:focus-visible {
          outline: 2px solid var(--ce-input-focus-ring, var(--ce-focus-ring, var(--ce-accent, #569cd6)));
          outline-offset: 1px;
        }
        input:disabled {
          background: var(--ce-input-disabled-bg, var(--ce-input-bg, var(--ce-surface, #1a1a1a)));
          border-color: var(--ce-input-disabled-border, var(--ce-input-border, var(--ce-border, #444)));
          color: var(--ce-input-disabled-fg, var(--ce-input-fg, var(--ce-text-primary, #fff)));
          cursor: not-allowed;
        }
        input::placeholder { color: var(--ce-input-placeholder, var(--ce-text-muted, #444)); }
      </style>
      <input type="${escapeAttr(type)}" value="${escapeAttr(value)}" placeholder="${escapeAttr(placeholder)}"
        ${disabled ? 'disabled' : ''} ${readonly ? 'readonly' : ''}>
    `;
  }

  private setupEvents() {
    const input = this.shadowRoot!.querySelector('input')!;
    input.addEventListener('input', () => {
      this.dispatchEvent(new CustomEvent('ce-input', {
        detail: { value: input.value },
        bubbles: true,
        composed: true,
      }));
    });
    input.addEventListener('change', () => {
      this.setAttribute('value', input.value);
      this.dispatchEvent(new CustomEvent('ce-change', {
        detail: { value: input.value },
        bubbles: true,
        composed: true,
      }));
    });
  }
}

function escapeAttr(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

customElements.define('ce-input', Input);
