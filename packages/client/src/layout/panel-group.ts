import './panel';

export class PanelGroup extends HTMLElement {
  static observedAttributes = ['data-drop-edge', 'data-drop-target-tab-id', 'data-drop-placement'];

  private observer: MutationObserver | null = null;

  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
    }
    this.syncLayoutChrome();
    this.ensureActivePanel();
    this.render();
    this.observePanels();
    queueMicrotask(() => {
      if (!this.isConnected) return;
      this.ensureActivePanel();
      this.render();
    });
  }

  disconnectedCallback() {
    this.observer?.disconnect();
  }

  refresh(): void {
    this.syncLayoutChrome();
    this.ensureActivePanel();
    this.render();
  }

  attributeChangedCallback() {
    if (this.shadowRoot) {
      this.render();
    }
  }

  private get panels(): HTMLElement[] {
    return Array.from(this.children).filter((child): child is HTMLElement => (
      child instanceof HTMLElement && child.tagName.toLowerCase() === 'ce-panel'
    ));
  }

  private syncLayoutChrome() {
    const layoutParent = this.parentElement?.closest('ce-split-pane, ce-panel, ce-panel-group, ce-tab');
    this.toggleAttribute('layout-nested', Boolean(layoutParent));
  }

  private ensureActivePanel() {
    const panels = this.panels;
    if (panels.length === 0 || panels.some((panel) => panel.hasAttribute('active'))) {
      return;
    }

    panels[0].setAttribute('active', '');
  }

  private render() {
    this.panels.forEach((panel) => panel.setAttribute('chromeless', ''));

    const tabs = this.panels.map((panel, index) => {
      const active = panel.hasAttribute('active');
      const title = panel.getAttribute('title') || `Panel ${index + 1}`;
      const tabId = panel.dataset.tabId || `tab-${index}`;
      return `
        <button
          class="tab-item${active ? ' active' : ''}"
          type="button"
          draggable="true"
          data-index="${index}"
          data-tab-id="${escapeAttr(tabId)}"
        >
          ${escapeHtml(title)}
        </button>
      `;
    }).join('');

    const dropEdge = this.getAttribute('data-drop-edge');
    const dropTargetTabId = this.getAttribute('data-drop-target-tab-id');
    const dropPlacement = this.getAttribute('data-drop-placement');

    this.shadowRoot!.innerHTML = `
      <style>
        :host {
          display: flex;
          flex: 1;
          flex-direction: column;
          min-width: var(--layout-min-width, var(--panel-min-width, var(--panel-min-size, 100px)));
          min-height: var(--layout-min-height, var(--panel-min-height, var(--panel-min-size, 100px)));
          overflow: hidden;
          background: transparent;
          border: var(--ce-panel-group-border-width, 1px) solid var(--ce-panel-group-border-color, var(--ce-border, #444));
          border-radius: var(--ce-panel-group-radius, var(--ce-radius-sm, 4px));
          position: relative;
        }
        :host([layout-nested]) {
          border: 0;
          border-radius: 0;
        }
        .tab-bar {
          display: flex;
          flex-shrink: 0;
          height: var(--panel-group-tabs-height, 28px);
          min-width: 0;
          overflow-x: auto;
          overflow-y: hidden;
          background: var(--ce-tabbar-bg, var(--ce-surface-raised, #2d2d2d));
          border-bottom: var(--ce-tabbar-border-width, 1px) solid var(--ce-tabbar-border-color, var(--ce-border, #444));
          position: relative;
        }
        .tab-item {
          display: inline-flex;
          align-items: center;
          padding: 0 var(--ce-space-3, 12px);
          border: 0;
          border-right: 1px solid var(--ce-tab-separator, var(--ce-border, #444));
          border-bottom: 2px solid transparent;
          color: var(--ce-tab-fg, var(--ce-text-secondary, #888));
          background: var(--ce-tab-bg, transparent);
          font: inherit;
          font-size: var(--ce-font-xs, 11px);
          white-space: nowrap;
          min-width: 0;
          cursor: pointer;
          border-radius: var(--ce-tab-radius, var(--ce-radius-sm, 8px)) var(--ce-tab-radius, var(--ce-radius-sm, 8px)) 0 0;
        }
        .tab-item.active {
          color: var(--ce-tab-fg-active, var(--ce-text-primary, #fff));
          background: var(--ce-tab-bg-active, var(--ce-surface, #1a1a1a));
          border-bottom-color: var(--ce-tab-active-indicator, var(--ce-accent, #569cd6));
        }
        .tab-item:hover {
          color: var(--ce-tab-fg-active, var(--ce-text-primary, #fff));
          background: var(--ce-tab-bg-hover, var(--ce-surface, #1a1a1a));
        }
        :host([variant="document"]) {
          border-radius: 0;
        }
        :host([variant="document"]) .tab-bar {
          align-items: flex-end;
          height: var(--panel-group-tabs-height, 34px);
          padding-left: var(--ce-space-1, 4px);
          background: var(--ce-tabbar-bg, var(--ce-surface-raised, #2d2d2d));
        }
        :host([variant="document"]) .tab-item {
          height: 30px;
          margin-top: 4px;
          padding: 0 10px;
          gap: var(--ce-space-2, 8px);
          border: 1px solid transparent;
          border-bottom: 0;
          border-radius: 6px 6px 0 0;
          background: var(--ce-tab-bg, transparent);
          font-size: var(--ce-font-sm, 12px);
        }
        :host([variant="document"]) .tab-item::after {
          content: "x";
          color: var(--ce-text-muted, #666);
          font-size: var(--ce-font-md, 14px);
          line-height: 1;
        }
        :host([variant="document"]) .tab-item.active {
          color: var(--ce-tab-fg-active, var(--ce-text-primary, #fff));
          background: var(--ce-tab-bg-active, var(--ce-surface, #1a1a1a));
          border-color: var(--ce-tab-separator, var(--ce-border, #444));
          border-bottom-color: var(--ce-tab-bg-active, var(--ce-surface, #1a1a1a));
        }
        :host([variant="document"]) .tab-item.active::after,
        :host([variant="document"]) .tab-item:hover::after {
          color: var(--ce-text-secondary, #888);
        }
        .content {
          display: flex;
          flex: 1;
          min-width: 0;
          min-height: 0;
          overflow: hidden;
          position: relative;
        }
        .content slot {
          display: flex;
          flex: 1;
          min-width: 0;
          min-height: 0;
          overflow: hidden;
        }
        .content ::slotted(ce-panel) {
          display: none;
        }
        .content ::slotted(ce-panel[active]) {
          display: flex;
          min-width: 0;
          min-height: 0;
          height: 100%;
          background: transparent;
          overflow: hidden;
        }
        .content ::slotted(ce-panel[modal-open]) {
          display: flex;
        }
        .drop-indicator {
          position: absolute;
          top: 4px;
          bottom: 4px;
          width: 2px;
          background: var(--ce-drop-indicator-color, var(--ce-accent, #569cd6));
          pointer-events: none;
        }
        .drop-indicator[data-placement="before"] {
          left: 4px;
        }
        .drop-indicator[data-placement="after"] {
          right: 4px;
        }
        .drop-edge-preview {
          position: absolute;
          inset: 0;
          border: 2px solid var(--ce-drop-zone-border-color, var(--ce-accent, #569cd6));
          background: var(--ce-drop-zone-fill, color-mix(in srgb, var(--ce-accent, #569cd6) 18%, transparent));
          pointer-events: none;
        }
        .drop-edge-preview[data-edge="left"] { clip-path: inset(0 70% 0 0); }
        .drop-edge-preview[data-edge="right"] { clip-path: inset(0 0 0 70%); }
        .drop-edge-preview[data-edge="top"] { clip-path: inset(0 0 70% 0); }
        .drop-edge-preview[data-edge="bottom"] { clip-path: inset(70% 0 0 0); }
      </style>
      <div class="tab-bar" data-drop-region="tab-strip">
        ${tabs}
        ${dropTargetTabId && dropPlacement ? `
          <div
            class="drop-indicator"
            data-target-tab-id="${escapeAttr(dropTargetTabId)}"
            data-placement="${escapeAttr(dropPlacement)}"
          ></div>
        ` : ''}
      </div>
      <div class="content" data-drop-region="panel-content">
        <slot></slot>
        ${dropEdge ? `<div class="drop-edge-preview" data-edge="${escapeAttr(dropEdge)}"></div>` : ''}
      </div>
    `;

    this.shadowRoot!.querySelector('.tab-bar')!.addEventListener('click', (event) => {
      const tab = (event.target as HTMLElement).closest('.tab-item') as HTMLElement | null;
      if (!tab) {
        return;
      }

      this.activate(Number(tab.dataset.index || '0'));
    });
  }

  private activate(index: number) {
    this.panels.forEach((panel, panelIndex) => {
      if (panelIndex === index) {
        panel.setAttribute('active', '');
      } else {
        panel.removeAttribute('active');
      }
    });

    const panel = this.panels[index];
    this.dispatchEvent(new CustomEvent('ce-panel-change', {
      detail: { title: panel?.getAttribute('title') || '', index },
      bubbles: true,
      composed: true,
    }));
    this.render();
  }

  private observePanels() {
    this.observer?.disconnect();
    this.observer = new MutationObserver(() => {
      this.ensureActivePanel();
      this.render();
    });
    this.observer.observe(this, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['active', 'title', 'data-tab-id'],
    });
  }
}

if (!customElements.get('ce-panel-group')) {
  customElements.define('ce-panel-group', PanelGroup);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}
