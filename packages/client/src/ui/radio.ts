export class Radio extends HTMLElement {
  static observedAttributes = ['checked', 'disabled', 'name', 'value'];

  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
    }
    this.render();
  }

  attributeChangedCallback(name: string, _oldVal: string | null, newVal: string | null) {
    if (!this.shadowRoot) return;
    const input = this.shadowRoot.querySelector('input');
    if (!input) return;

    if (name === 'checked') input.checked = newVal !== null;
    else if (name === 'disabled') input.disabled = newVal !== null;
    else if (name === 'name') input.name = newVal || '';
    else if (name === 'value') input.value = newVal || '';
  }

  private render() {
    const checked = this.hasAttribute('checked');
    const disabled = this.hasAttribute('disabled');
    const name = this.getAttribute('name') || '';
    const value = this.getAttribute('value') || '';

    this.shadowRoot!.innerHTML = `
      <style>
        :host { display: inline-flex; align-items: center; gap: var(--ce-space-1, 4px); }
        input[type="radio"] { accent-color: var(--ce-accent, #569cd6); margin: 0; }
        label { font-size: var(--ce-font-sm, 12px); color: var(--ce-text-primary, #fff); cursor: pointer; }
        input:disabled, input:disabled + label { opacity: 0.4; cursor: not-allowed; }
      </style>
      <input type="radio" id="r" name="${escapeAttr(name)}" value="${escapeAttr(value)}"
        ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
      <label for="r"><slot></slot></label>
    `;

    const input = this.shadowRoot!.querySelector('input')!;
    input.addEventListener('change', () => {
      if (name) {
        document.querySelectorAll(`ce-radio[name="${escapeSelectorValue(name)}"]`).forEach((radio) => {
          if (radio !== this) radio.removeAttribute('checked');
        });
      }
      this.setAttribute('checked', '');
      this.dispatchEvent(new CustomEvent('ce-change', {
        detail: { checked: true, value },
        bubbles: true,
        composed: true,
      }));
    });
  }
}

function escapeAttr(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function escapeSelectorValue(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

customElements.define('ce-radio', Radio);
