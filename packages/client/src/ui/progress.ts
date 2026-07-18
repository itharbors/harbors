export class Progress extends HTMLElement {
  static observedAttributes = ['value', 'indeterminate'];

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
    const value = this.clampedValue;
    const indeterminate = this.hasAttribute('indeterminate');

    this.shadowRoot!.innerHTML = `
      <style>
        :host {
          display: block;
        }
        .track {
          height: 6px;
          overflow: hidden;
          background: var(--ce-surface-raised, #2d2d2d);
          border-radius: 3px;
        }
        .fill {
          height: 100%;
          background: var(--ce-accent, #569cd6);
          border-radius: 3px;
          transition: width 0.3s;
        }
        .fill.indeterminate {
          width: 30%;
          animation: progress-indeterminate 1.2s ease-in-out infinite;
        }
        @keyframes progress-indeterminate {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(400%); }
        }
      </style>
      <div class="track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${value}">
        <div class="fill${indeterminate ? ' indeterminate' : ''}" style="width: ${value}%;"></div>
      </div>
    `;
  }

  private get clampedValue() {
    const parsed = Number.parseInt(this.getAttribute('value') || '0', 10);
    if (Number.isNaN(parsed)) return 0;
    return Math.max(0, Math.min(100, parsed));
  }
}

if (!customElements.get('ce-progress')) {
  customElements.define('ce-progress', Progress);
}
