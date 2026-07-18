export class Tab extends HTMLElement {
  static observedAttributes = ['active', 'label', 'closable'];

  get label(): string {
    return this.getAttribute('label') || '';
  }

  get closable(): boolean {
    return this.getAttribute('closable') !== 'false';
  }
}

if (!customElements.get('ce-tab')) {
  customElements.define('ce-tab', Tab);
}

export class Tabs extends HTMLElement {
  private observer: MutationObserver | null = null;

  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
    }
    this.render();
    this.observeTabs();
  }

  disconnectedCallback() {
    this.observer?.disconnect();
  }

  private get tabs(): Tab[] {
    return Array.from(this.querySelectorAll('ce-tab')) as Tab[];
  }

  private render() {
    const labelItems = this.tabs.map((tab, index) => {
      const active = tab.hasAttribute('active');
      const label = tab.getAttribute('label') || '';
      const closable = tab.getAttribute('closable') !== 'false';
      return `
        <div class="tab-item${active ? ' active' : ''}" data-index="${index}">
          <span class="tab-label">${escapeHtml(label)}</span>
          ${closable ? '<button class="tab-close" type="button" aria-label="Close tab">x</button>' : ''}
        </div>
      `;
    }).join('');

    this.shadowRoot!.innerHTML = `
      <style>
        :host {
          display: flex;
          flex: 1;
          flex-direction: column;
          min-width: 0;
          min-height: 0;
          overflow: hidden;
        }
        .tab-bar {
          display: flex;
          flex-shrink: 0;
          height: var(--tabs-height, 32px);
          overflow-x: auto;
          background: var(--ce-tabbar-bg, var(--ce-surface-raised, #2d2d2d));
          border-bottom: var(--tabs-border-bottom, 1px solid var(--ce-border, #444));
        }
        .tab-item {
          display: flex;
          align-items: center;
          gap: var(--ce-space-1, 4px);
          padding: 0 var(--ce-space-3, 12px);
          color: var(--ce-tab-fg, var(--ce-text-secondary, #888));
          background: var(--ce-tab-bg, transparent);
          border-bottom: 2px solid transparent;
          font-size: var(--ce-font-sm, 12px);
          white-space: nowrap;
          cursor: pointer;
        }
        .tab-item.active {
          color: var(--ce-tab-fg-active, var(--ce-text-primary, #fff));
          background: var(--ce-tab-bg-active, var(--ce-surface, #1a1a1a));
          border-bottom-color: var(--ce-tab-active-indicator, var(--ce-accent, #569cd6));
        }
        .tab-item:hover {
          background: var(--ce-tab-bg-hover, var(--ce-surface, #1a1a1a));
        }
        .tab-close {
          padding: 0;
          border: 0;
          color: var(--ce-text-muted, #444);
          background: transparent;
          font-size: var(--ce-font-md, 14px);
          line-height: 1;
          cursor: pointer;
        }
        .tab-close:hover {
          color: var(--ce-text-primary, #fff);
        }
        .tab-content {
          flex: 1;
          min-height: 0;
          overflow: hidden;
        }
        .tab-content ::slotted(ce-tab) {
          display: none;
        }
        .tab-content ::slotted(ce-tab[active]) {
          display: block;
          height: 100%;
        }
      </style>
      <div class="tab-bar">${labelItems}</div>
      <div class="tab-content"><slot></slot></div>
    `;

    this.shadowRoot!.querySelector('.tab-bar')!.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const tabItem = target.closest('.tab-item') as HTMLElement | null;
      if (!tabItem) {
        return;
      }

      const index = Number(tabItem.dataset.index || '0');
      const tab = this.tabs[index];
      if (!tab) {
        return;
      }

      if (target.closest('.tab-close')) {
        this.dispatchEvent(new CustomEvent('ce-tab-close', {
          detail: { label: tab.getAttribute('label') || '', index },
          bubbles: true,
          composed: true,
        }));
        return;
      }

      this.activate(index);
    });
  }

  private activate(index: number) {
    this.tabs.forEach((tab, tabIndex) => {
      if (tabIndex === index) {
        tab.setAttribute('active', '');
      } else {
        tab.removeAttribute('active');
      }
    });

    const tab = this.tabs[index];
    this.dispatchEvent(new CustomEvent('ce-tab-change', {
      detail: { label: tab?.getAttribute('label') || '', index },
      bubbles: true,
      composed: true,
    }));
    this.render();
  }

  private observeTabs() {
    this.observer?.disconnect();
    this.observer = new MutationObserver(() => this.render());
    this.observer.observe(this, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['active', 'label', 'closable'],
    });
  }
}

if (!customElements.get('ce-tabs')) {
  customElements.define('ce-tabs', Tabs);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
