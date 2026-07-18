export class Toggle extends HTMLElement {
  static observedAttributes = ['checked', 'disabled', 'label'];

  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
    }
    this.render();
  }

  attributeChangedCallback(name: string, _oldVal: string | null, newVal: string | null) {
    if (!this.shadowRoot) return;
    if (name === 'checked') {
      const input = this.shadowRoot.querySelector('input');
      if (input) input.checked = newVal !== null;
    } else {
      this.render();
    }
  }

  private render() {
    const checked = this.hasAttribute('checked');
    const disabled = this.hasAttribute('disabled');
    const label = this.getAttribute('label') || '';

    this.shadowRoot!.innerHTML = `
      <style>
        :host { display: inline-flex; align-items: center; gap: var(--ce-space-2, 8px); }
        .toggle-track {
          width: 32px; height: 18px; border-radius: 9px;
          background: var(--ce-surface-raised, #2d2d2d);
          border: 1px solid var(--ce-border, #444);
          position: relative; cursor: pointer; transition: background 0.15s;
        }
        input { display: none; }
        input:checked + .toggle-track {
          background: var(--ce-accent, #569cd6);
          border-color: var(--ce-accent, #569cd6);
        }
        .toggle-track::after {
          content: ''; position: absolute; top: 2px; left: 2px;
          width: 12px; height: 12px; border-radius: 50%;
          background: var(--ce-text-secondary, #888); transition: left 0.15s;
        }
        input:checked + .toggle-track::after {
          left: 16px; background: #fff;
        }
        .label { font-size: var(--ce-font-sm, 12px); color: var(--ce-text-primary, #fff); cursor: pointer; }
        input:disabled + .toggle-track, input:disabled ~ .label { opacity: 0.4; cursor: not-allowed; }
      </style>
      <input type="checkbox" id="tg" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
      <label class="toggle-track" for="tg"></label>
      <label class="label" for="tg">${escapeHtml(label)}</label>
    `;

    const input = this.shadowRoot!.querySelector('input')!;
    input.addEventListener('change', () => {
      if (input.checked) {
        this.setAttribute('checked', '');
      } else {
        this.removeAttribute('checked');
      }
      this.dispatchEvent(new CustomEvent('ce-change', {
        detail: { checked: input.checked },
        bubbles: true,
        composed: true,
      }));
    });
  }
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

customElements.define('ce-toggle', Toggle);
