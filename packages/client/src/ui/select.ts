export class Option extends HTMLElement {
  static observedAttributes = ['value', 'selected', 'disabled'];
}

customElements.define('ce-option', Option);

export class Select extends HTMLElement {
  static observedAttributes = ['disabled', 'value'];

  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
    }
    this.render();
    this.setupEvents();
  }

  attributeChangedCallback(name: string, _oldVal: string | null, newVal: string | null) {
    if (!this.shadowRoot) return;
    if (name === 'value') {
      const select = this.shadowRoot.querySelector('select');
      if (select) select.value = newVal || '';
      return;
    }
    this.render();
    this.setupEvents();
  }

  private get options(): Option[] {
    return Array.from(this.querySelectorAll('ce-option'));
  }

  private render() {
    const disabled = this.hasAttribute('disabled');
    const value = this.getAttribute('value');
    const optionEls = this.options.map((opt) => {
      const optValue = opt.getAttribute('value') || '';
      const selected = value !== null ? value === optValue : opt.hasAttribute('selected');
      const optDisabled = opt.hasAttribute('disabled');
      const text = opt.textContent || optValue;
      return `<option value="${escapeAttr(optValue)}"${selected ? ' selected' : ''}${optDisabled ? ' disabled' : ''}>${escapeHtml(text)}</option>`;
    }).join('');

    this.shadowRoot!.innerHTML = `
      <style>
        :host { display: inline-block; }
        select {
          height: 30px;
          padding: 0 var(--ce-space-2, 8px);
          background: var(--ce-input-bg, var(--ce-surface, #1a1a1a));
          border: 1px solid var(--ce-input-border, var(--ce-border, #444));
          border-radius: var(--ce-radius-sm, 4px);
          color: var(--ce-input-fg, var(--ce-text-primary, #fff));
          font-size: var(--ce-font-sm, 12px);
          font-family: inherit;
          outline: none;
          cursor: pointer;
        }
        select:focus-visible {
          outline: 2px solid var(--ce-input-focus-ring, var(--ce-focus-ring, var(--ce-accent, #569cd6)));
          outline-offset: 1px;
        }
        select:disabled {
          background: var(--ce-input-disabled-bg, var(--ce-input-bg, var(--ce-surface, #1a1a1a)));
          border-color: var(--ce-input-disabled-border, var(--ce-input-border, var(--ce-border, #444)));
          color: var(--ce-input-disabled-fg, var(--ce-input-fg, var(--ce-text-primary, #fff)));
          cursor: not-allowed;
        }
      </style>
      <select ${disabled ? 'disabled' : ''}>${optionEls}</select>
    `;
  }

  private setupEvents() {
    const select = this.shadowRoot!.querySelector('select')!;
    select.addEventListener('change', () => {
      this.setAttribute('value', select.value);
      this.options.forEach((opt) => {
        if (opt.getAttribute('value') === select.value) opt.setAttribute('selected', '');
        else opt.removeAttribute('selected');
      });
      this.dispatchEvent(new CustomEvent('ce-change', {
        detail: { value: select.value },
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

customElements.define('ce-select', Select);
