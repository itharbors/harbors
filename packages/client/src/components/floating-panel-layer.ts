import '../layout/panel-group';
import { i18nStore } from '../i18n/store';

export interface FloatingPanelState {
  id: string;
  panelName: string;
  title: string;
  titleKey?: string;
  src: string;
  state: 'open' | 'minimized';
  position?: { x: number; y: number };
  edge?: 'left' | 'right' | 'bottom';
}

export class FloatingPanelLayer extends HTMLElement {
  static observedAttributes = ['data-state'];

  private disposeI18n: (() => void) | null = null;
  private handleClick = (event: Event) => this.handleShadowClick(event);

  private get items(): FloatingPanelState[] {
    const raw = this.getAttribute('data-state');
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isFloatingPanelState) : [];
    } catch {
      return [];
    }
  }

  connectedCallback(): void {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
    }
    this.shadowRoot?.addEventListener('click', this.handleClick);
    this.disposeI18n = i18nStore.subscribe((event) => {
      const titleKeys = this.items
        .filter((item) => item.state === 'minimized')
        .map((item) => item.titleKey)
        .filter((titleKey): titleKey is string => Boolean(titleKey));
      if (event.type === 'locale-changed' || titleKeys.some((titleKey) => event.changedKeys.includes(titleKey))) {
        this.syncMinimizedChipTitles();
      }
    });
    this.render();
  }

  disconnectedCallback(): void {
    this.shadowRoot?.removeEventListener('click', this.handleClick);
    this.disposeI18n?.();
    this.disposeI18n = null;
  }

  attributeChangedCallback(): void {
    if (this.shadowRoot) {
      this.render();
    }
  }

  private render(): void {
    const items = this.items;
    this.toggleAttribute('has-items', items.length > 0);
    this.setAttribute('data-count', String(items.length));
    this.shadowRoot!.innerHTML = `
      <style>
        :host {
          position: absolute;
          inset: 0;
          z-index: 20;
          pointer-events: none;
        }
        .floating-window {
          position: absolute;
          width: min(420px, calc(100% - 32px));
          height: min(320px, calc(100% - 32px));
          min-width: 240px;
          min-height: 180px;
          pointer-events: auto;
          box-shadow: var(--ce-floating-shadow, 0 16px 40px rgba(0, 0, 0, 0.35));
          display: flex;
          flex-direction: column;
          background: var(--ce-surface, #1f1f1f);
          border: 1px solid var(--ce-border, #3f3f3f);
          border-radius: 8px;
          overflow: hidden;
        }
        .floating-toolbar {
          display: flex;
          align-items: center;
          gap: 8px;
          min-height: 32px;
          padding: 0 8px 0 10px;
          color: var(--ce-text-primary, #fff);
          background: var(--ce-panel-header-bg, rgba(255, 255, 255, 0.04));
          border-bottom: 1px solid var(--ce-border, #3f3f3f);
        }
        .floating-title {
          flex: 1 1 auto;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 12px;
        }
        .floating-action {
          width: 24px;
          height: 24px;
          border: 0;
          border-radius: 4px;
          color: inherit;
          background: transparent;
          cursor: pointer;
        }
        .floating-action:hover {
          background: var(--ce-hover-bg, rgba(255, 255, 255, 0.08));
        }
        ce-panel-group {
          flex: 1 1 auto;
          min-height: 0;
        }
        .edge-chip {
          position: absolute;
          pointer-events: auto;
          border: 1px solid var(--ce-border, #444);
          border-radius: 999px;
          padding: 6px 10px;
          background: var(--ce-surface-raised, #2d2d2d);
          color: var(--ce-text-primary, #fff);
          font: inherit;
          font-size: 12px;
          cursor: pointer;
        }
      </style>
      ${items.filter((item) => item.state === 'open').map((item) => `
        <div
          class="floating-window"
          data-panel-instance-id="${escapeAttr(item.id)}"
          style="left:${item.position?.x ?? 80}px;top:${item.position?.y ?? 64}px;"
        >
          <div class="floating-toolbar">
            <span class="floating-title">${escapeHtml(getDisplayTitle(item))}</span>
            <button
              class="floating-action"
              type="button"
              data-floating-action="minimize"
              data-panel-instance-id="${escapeAttr(item.id)}"
              aria-label="Minimize ${escapeAttr(getDisplayTitle(item))}"
              title="Minimize"
            >_</button>
            <button
              class="floating-action"
              type="button"
              data-floating-action="close"
              data-panel-instance-id="${escapeAttr(item.id)}"
              aria-label="Close ${escapeAttr(getDisplayTitle(item))}"
              title="Close"
            >x</button>
          </div>
          <ce-panel-group data-group-id="floating-${escapeAttr(item.id)}" data-session-id="" data-window-id="main-window">
            <ce-panel
              active
              data-tab-id="floating-tab-${escapeAttr(item.id)}"
              data-panel-name="${escapeAttr(item.panelName)}"
              title="${escapeAttr(item.title)}"
              ${item.titleKey ? `title-i18n="${escapeAttr(item.titleKey)}"` : ''}
              src="${escapeAttr(item.src)}"
            ></ce-panel>
          </ce-panel-group>
        </div>
      `).join('')}
      ${items.filter((item) => item.state === 'minimized').map((item, index) => `
        <button
          class="edge-chip"
          type="button"
          data-panel-instance-id="${escapeAttr(item.id)}"
          data-floating-action="restore"
          ${item.titleKey ? `data-title-i18n="${escapeAttr(item.titleKey)}"` : ''}
          style="${renderChipPosition(item.edge ?? 'bottom', index)}"
          aria-label="Restore ${escapeAttr(getDisplayTitle(item))}"
        >
          ${escapeHtml(getDisplayTitle(item))}
        </button>
      `).join('')}
    `;
    queueMicrotask(() => {
      this.shadowRoot?.querySelectorAll('ce-panel-group').forEach((group) => {
        (group as HTMLElement & { refresh?: () => void }).refresh?.();
      });
    });
  }

  private syncMinimizedChipTitles(): void {
    const itemsById = new Map(this.items.map((item) => [item.id, item]));
    this.shadowRoot?.querySelectorAll('.edge-chip').forEach((chip) => {
      const id = (chip as HTMLElement).dataset.panelInstanceId;
      const item = id ? itemsById.get(id) : undefined;
      if (!item) return;
      chip.textContent = getDisplayTitle(item);
    });
  }

  private handleShadowClick(event: Event): void {
    const target = event.target as HTMLElement | null;
    const actionElement = target?.closest<HTMLElement>('[data-floating-action]');
    const action = actionElement?.dataset.floatingAction;
    const panelInstanceId = actionElement?.dataset.panelInstanceId;
    if (!action || !panelInstanceId) return;

    event.preventDefault();
    event.stopPropagation();
    this.dispatchEvent(new CustomEvent(`ce-floating-panel-${action}`, {
      bubbles: true,
      composed: true,
      detail: { panelInstanceId },
    }));
  }
}

if (!customElements.get('floating-panel-layer')) {
  customElements.define('floating-panel-layer', FloatingPanelLayer);
}

function isFloatingPanelState(value: unknown): value is FloatingPanelState {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<FloatingPanelState>;
  return typeof item.id === 'string'
    && typeof item.panelName === 'string'
    && typeof item.title === 'string'
    && typeof item.src === 'string'
    && (item.state === 'open' || item.state === 'minimized');
}

function renderChipPosition(edge: 'left' | 'right' | 'bottom', index: number): string {
  if (edge === 'left') return `left:8px;bottom:${8 + index * 36}px;`;
  if (edge === 'right') return `right:8px;bottom:${8 + index * 36}px;`;
  return `left:${8 + index * 120}px;bottom:8px;`;
}

function getDisplayTitle(item: FloatingPanelState): string {
  return item.titleKey ? i18nStore.t(item.titleKey) : item.title;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}
