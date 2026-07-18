export class SplitPane extends HTMLElement {
  static observedAttributes = ['direction'];

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

  private get direction(): 'row' | 'column' {
    return this.getAttribute('direction') === 'column' ? 'column' : 'row';
  }

  private render() {
    this.shadowRoot!.innerHTML = `
      <style>
        :host {
          display: flex;
          flex: 1;
          min-width: 0;
          min-height: 0;
          overflow: hidden;
        }
        .container {
          display: flex;
          flex: 1;
          flex-direction: ${this.direction};
          min-width: 0;
          min-height: 0;
          gap: var(--split-gap, 0);
          overflow: hidden;
        }
      </style>
      <div class="container" style="flex-direction: ${this.direction};">
        <slot></slot>
      </div>
    `;
  }
}

if (!customElements.get('ce-split-pane')) {
  customElements.define('ce-split-pane', SplitPane);
}
