export class Checkbox extends HTMLElement {
  static observedAttributes = ['checked', 'disabled', 'label'];

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
    const checked = this.hasAttribute('checked');
    const disabled = this.hasAttribute('disabled');
    const label = this.getAttribute('label') || '';

    this.shadowRoot!.innerHTML = `
      <style>
        :host { display: inline-flex; align-items: center; gap: var(--ce-space-1, 4px); }
        label {
          display: inline-flex;
          align-items: center;
          gap: var(--ce-space-1, 4px);
          font-size: var(--ce-font-sm, 12px);
          color: var(--ce-text-primary, #fff);
          cursor: pointer;
        }
        input[type="checkbox"] {
          appearance: none;
          -webkit-appearance: none;
          width: 14px;
          height: 14px;
          margin: 0;
          border-radius: 3px;
          border: 1px solid var(--ce-checkbox-border, var(--ce-border, #444));
          background: var(--ce-checkbox-bg, var(--ce-surface, #1a1a1a));
          display: inline-grid;
          place-content: center;
          cursor: pointer;
        }
        input[type="checkbox"]::after {
          content: '';
          width: 4px;
          height: 8px;
          border-right: 2px solid var(--ce-checkbox-check, #fff);
          border-bottom: 2px solid var(--ce-checkbox-check, #fff);
          transform: rotate(45deg) scale(0);
          transform-origin: center;
        }
        input[type="checkbox"]:checked {
          background: var(--ce-checkbox-bg-checked, var(--ce-accent, #569cd6));
          border-color: var(--ce-checkbox-border-checked, var(--ce-accent, #569cd6));
        }
        input[type="checkbox"]:checked::after {
          transform: rotate(45deg) scale(1);
        }
        input[type="checkbox"]:focus-visible {
          outline: 2px solid var(--ce-checkbox-focus-ring, var(--ce-focus-ring, var(--ce-accent, #569cd6)));
          outline-offset: 1px;
        }
        input:disabled,
        input:disabled + span,
        input:disabled + span + label,
        input:disabled + label {
          opacity: var(--ce-checkbox-disabled-opacity, 0.4);
          cursor: not-allowed;
        }
      </style>
      <input type="checkbox" id="cb" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
      <label for="cb">${escapeHtml(label)}</label>
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

customElements.define('ce-checkbox', Checkbox);
