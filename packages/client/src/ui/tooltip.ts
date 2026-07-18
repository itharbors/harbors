export class Tooltip extends HTMLElement {
  static observedAttributes = ['content', 'position', 'delay'];

  private timer: ReturnType<typeof setTimeout> | null = null;
  private tipEl: HTMLElement | null = null;

  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
    }
    this.render();
    this.setupEvents();
  }

  disconnectedCallback() {
    this.clearTimer();
  }

  attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null) {
    if (!this.tipEl) return;

    if (name === 'content') {
      this.tipEl.textContent = newValue || '';
    }

    if (name === 'position') {
      this.tipEl.className = `tip ${this.position}`;
    }
  }

  private get position() {
    return this.getAttribute('position') || 'top';
  }

  private render() {
    this.shadowRoot!.innerHTML = `
      <style>
        :host {
          display: inline-block;
          position: relative;
        }
        .tip {
          position: absolute;
          z-index: 1000;
          padding: var(--ce-space-1, 4px) var(--ce-space-2, 8px);
          background: var(--ce-surface-raised, #2d2d2d);
          border: 1px solid var(--ce-border, #444);
          border-radius: var(--ce-radius-sm, 4px);
          color: var(--ce-text-primary, #fff);
          font-size: var(--ce-font-xs, 11px);
          white-space: nowrap;
          pointer-events: none;
        }
        .tip.top { bottom: calc(100% + 4px); left: 50%; transform: translateX(-50%); }
        .tip.bottom { top: calc(100% + 4px); left: 50%; transform: translateX(-50%); }
        .tip.left { right: calc(100% + 4px); top: 50%; transform: translateY(-50%); }
        .tip.right { left: calc(100% + 4px); top: 50%; transform: translateY(-50%); }
      </style>
      <slot></slot>
    `;
  }

  private setupEvents() {
    this.addEventListener('mouseenter', this.handleMouseEnter);
    this.addEventListener('mouseleave', this.handleMouseLeave);
  }

  private handleMouseEnter = () => {
    this.clearTimer();
    const delay = Number.parseInt(this.getAttribute('delay') || '500', 10);
    this.timer = setTimeout(() => this.showTip(), Number.isNaN(delay) ? 500 : delay);
  };

  private handleMouseLeave = () => {
    this.clearTimer();
    this.hideTip();
  };

  private showTip() {
    this.hideTip();

    const content = this.getAttribute('content') || '';
    this.tipEl = document.createElement('div');
    this.tipEl.className = `tip ${this.position}`;
    this.tipEl.textContent = content;
    this.shadowRoot!.appendChild(this.tipEl);
  }

  private hideTip() {
    this.tipEl?.remove();
    this.tipEl = null;
  }

  private clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

if (!customElements.get('ce-tooltip')) {
  customElements.define('ce-tooltip', Tooltip);
}
