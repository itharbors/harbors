import '../layout/panel-group';
import { i18nStore } from '../i18n/store';

export interface FloatingPanelState {
  id: string;
  panelName: string;
  title: string;
  titleKey?: string;
  src: string;
  availability?: 'available' | 'unavailable';
  revision?: number;
  state: 'open';
  position?: { x: number; y: number };
  size?: { width: number; height: number };
  localOnly?: boolean;
}

type Geometry = { x: number; y: number; width: number; height: number };
type GestureMode = 'move' | 'resize-left' | 'resize-right';
type ActiveGesture = {
  id: string; pointerId: number; mode: GestureMode; startX: number; startY: number;
  initial: Geometry; current: Geometry; target: HTMLElement; window: HTMLElement; shield: HTMLElement;
};

export class FloatingPanelLayer extends HTMLElement {
  static observedAttributes = ['data-state'];

  private disposeI18n: (() => void) | null = null;
  private suppressAttributeRender = false;
  private handleClick = (event: Event) => this.handleShadowClick(event);
  private handlePointerDown = (event: Event) => this.startGesture(event as PointerEvent);
  private handlePointerMove = (event: PointerEvent) => this.moveGesture(event);
  private handlePointerUp = (event: PointerEvent) => this.finishGesture(event, false);
  private handlePointerCancel = (event: PointerEvent) => this.finishGesture(event, true);
  private handleLostPointerCapture = (event: PointerEvent) => this.finishGesture(event, true);
  private handleWindowBlur = () => this.cancelGesture();
  private gesture: ActiveGesture | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private readonly records = new Map<string, { window?: HTMLElement; panelName: string }>();

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
    this.shadowRoot?.addEventListener('pointerdown', this.handlePointerDown);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.constrainWindows());
      this.resizeObserver.observe(this);
    }
    this.disposeI18n = i18nStore.subscribe((event) => {
      const titleKeys = this.items
        .map((item) => item.titleKey)
        .filter((titleKey): titleKey is string => Boolean(titleKey));
      if (event.type === 'locale-changed' || titleKeys.some((titleKey) => event.changedKeys.includes(titleKey))) {
        this.syncTitles();
      }
    });
    this.render();
  }

  disconnectedCallback(): void {
    this.shadowRoot?.removeEventListener('click', this.handleClick);
    this.shadowRoot?.removeEventListener('pointerdown', this.handlePointerDown);
    this.cancelGesture();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.disposeI18n?.();
    this.disposeI18n = null;
  }

  attributeChangedCallback(): void {
    if (this.shadowRoot && !this.suppressAttributeRender) {
      this.render();
    }
  }

  /** Update only the affected floating panel after a plugin availability event. */
  updatePanelAvailability(input: {
    panelName: string;
    src: string;
    state: 'available' | 'unavailable';
    revision: number;
  }): void {
    const nextItems = this.items.map((item) => item.panelName === input.panelName
      ? {
        ...item,
        src: input.state === 'available' ? input.src : '',
        availability: input.state,
        revision: input.revision,
      }
      : item);

    this.suppressAttributeRender = true;
    this.setAttribute('data-state', JSON.stringify(nextItems));
    this.suppressAttributeRender = false;

    this.shadowRoot?.querySelectorAll<HTMLElement>(`ce-panel[data-panel-name="${escapeSelector(input.panelName)}"]`)
      .forEach((panel) => {
        panel.setAttribute('data-panel-revision', String(input.revision));
        if (input.state === 'unavailable') {
          panel.removeAttribute('src');
          panel.setAttribute('availability', 'unavailable');
        } else {
          panel.setAttribute('availability', 'available');
          panel.setAttribute('src', input.src);
        }
      });
  }

  private render(): void {
    const items = this.items;
    this.toggleAttribute('has-items', items.length > 0);
    this.setAttribute('data-count', String(items.length));
    if (!this.shadowRoot!.querySelector('style')) this.shadowRoot!.innerHTML = `
      <style>
        :host {
          position: absolute;
          inset: 0;
          z-index: 20;
          pointer-events: none;
        }
        .floating-window {
          position: absolute;
          box-sizing: border-box;
          width: min(420px, calc(100% - 32px));
          height: min(320px, calc(100% - 32px));
          min-width: min(240px, 100%);
          min-height: min(180px, 100%);
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
          cursor: move;
          touch-action: none;
          user-select: none;
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
        .floating-resize {
          position: absolute;
          bottom: 0;
          width: 20px;
          height: 20px;
          z-index: 2;
          cursor: nwse-resize;
          touch-action: none;
        }
        .floating-resize.left { left: 0; cursor: nesw-resize; }
        .floating-resize.right { right: 0; }
        .floating-resize::after {
          content: '';
          position: absolute;
          bottom: 4px;
          width: 8px;
          height: 8px;
          border-bottom: 2px solid var(--ce-text-muted, #94a3b8);
        }
        .floating-resize.left::after { left: 4px; border-left: 2px solid var(--ce-text-muted, #94a3b8); }
        .floating-resize.right::after { right: 4px; border-right: 2px solid var(--ce-text-muted, #94a3b8); }
        .gesture-shield { position: absolute; inset: 0; z-index: 50; pointer-events: auto; touch-action: none; }
        ce-panel-group, .floating-window > ce-panel {
          flex: 1 1 auto;
          min-height: 0;
        }
      </style>
    `;
    const activeIds = new Set(items.map((item) => item.id));
    for (const [id, record] of this.records) {
      if (activeIds.has(id)) continue;
      if (this.gesture?.id === id) this.cancelGesture();
      record.window?.remove();
      this.records.delete(id);
    }

    for (const item of items) {
      let record = this.records.get(item.id);
      if (record && record.panelName !== item.panelName) {
        if (this.gesture?.id === item.id) this.cancelGesture();
        record.window?.remove();
        this.records.delete(item.id);
        record = undefined;
      }
      if (!record) {
        record = { panelName: item.panelName };
        this.records.set(item.id, record);
      }
      if (!record.window) {
        record.window = this.createWindow(item);
        this.shadowRoot!.append(record.window);
      }
      if (record.window) {
        if (item.position && this.gesture?.id !== item.id) {
          record.window.style.left = `${item.position.x}px`;
          record.window.style.top = `${item.position.y}px`;
        }
        if (item.size && this.gesture?.id !== item.id) {
          record.window.style.width = `${item.size.width}px`;
          record.window.style.height = `${item.size.height}px`;
        }
        this.syncWindow(record.window, item);
      }
    }
    queueMicrotask(() => { if (this.isConnected) this.constrainWindows(); });
  }

  private createWindow(item: FloatingPanelState): HTMLElement {
    const element = document.createElement('div');
    element.className = 'floating-window';
    element.dataset.panelInstanceId = item.id;
    element.style.left = `${item.position?.x ?? 80}px`;
    element.style.top = `${item.position?.y ?? 64}px`;
    element.innerHTML = `
      <div class="floating-toolbar">
        <span class="floating-title"></span>
        <button class="floating-action" type="button" data-floating-action="close" data-panel-instance-id="${escapeAttr(item.id)}" title="Close">x</button>
      </div>
      ${item.localOnly
        ? `<ce-panel active data-panel-name="${escapeAttr(item.panelName)}"></ce-panel>`
        : `<ce-panel-group data-group-id="floating-${escapeAttr(item.id)}" data-session-id="" data-window-id="main-window"><ce-panel active data-tab-id="floating-tab-${escapeAttr(item.id)}" data-panel-name="${escapeAttr(item.panelName)}"></ce-panel></ce-panel-group>`}
      <div class="floating-resize left" data-resize="left" aria-hidden="true"></div>
      <div class="floating-resize right" data-resize="right" aria-hidden="true"></div>`;
    return element;
  }

  private syncWindow(element: HTMLElement, item: FloatingPanelState): void {
    const title = getDisplayTitle(item);
    element.querySelector('.floating-title')!.textContent = title;
    element.querySelector('[data-floating-action="close"]')!.setAttribute('aria-label', `Close ${title}`);
    const panel = element.querySelector('ce-panel')!;
    setOptionalAttribute(panel, 'title-i18n', item.titleKey);
    setOptionalAttribute(panel, 'title', title);
    setOptionalAttribute(panel, 'data-panel-revision', item.revision === undefined ? undefined : String(item.revision));
    if (item.availability === 'unavailable') {
      setOptionalAttribute(panel, 'availability', 'unavailable');
      setOptionalAttribute(panel, 'src', undefined);
    } else {
      setOptionalAttribute(panel, 'availability', item.availability);
      setOptionalAttribute(panel, 'src', item.src || undefined);
    }
  }

  private syncTitles(): void {
    for (const item of this.items) {
      const record = this.records.get(item.id);
      if (record?.window) this.syncWindow(record.window, item);
    }
  }

  private startGesture(event: PointerEvent): void {
    if (this.gesture || !event.isPrimary || event.button !== 0) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    const resize = target?.closest<HTMLElement>('[data-resize]');
    const toolbar = target?.closest<HTMLElement>('.floating-toolbar');
    if (!resize && (!toolbar || target?.closest('button'))) return;
    const owner = (resize || toolbar)?.closest<HTMLElement>('.floating-window');
    const id = owner?.dataset.panelInstanceId;
    if (!owner || !id || owner.hidden) return;
    const bounds = this.getBoundingClientRect();
    const rect = owner.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0 || rect.width <= 0 || rect.height <= 0) return;
    const mode: GestureMode = resize ? (resize.dataset.resize === 'left' ? 'resize-left' : 'resize-right') : 'move';
    const initial = constrainGeometry({ x: rect.left - bounds.left, y: rect.top - bounds.top, width: rect.width, height: rect.height }, bounds.width, bounds.height);
    const shield = document.createElement('div');
    shield.className = 'gesture-shield';
    shield.style.cursor = mode === 'move' ? 'move' : mode === 'resize-left' ? 'nesw-resize' : 'nwse-resize';
    const captureTarget = (resize || toolbar)!;
    this.gesture = { id, pointerId: event.pointerId, mode, startX: event.clientX, startY: event.clientY, initial, current: initial, target: captureTarget, window: owner, shield };
    event.preventDefault();
    try { captureTarget.setPointerCapture(event.pointerId); } catch { /* The shield still prevents iframe interception. */ }
    this.shadowRoot!.append(shield);
    captureTarget.addEventListener('lostpointercapture', this.handleLostPointerCapture);
    window.addEventListener('pointermove', this.handlePointerMove, true);
    window.addEventListener('pointerup', this.handlePointerUp, true);
    window.addEventListener('pointercancel', this.handlePointerCancel, true);
    window.addEventListener('blur', this.handleWindowBlur);
    this.applyGeometry(owner, initial);
  }

  private moveGesture(event: PointerEvent): void {
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const bounds = this.getBoundingClientRect();
    gesture.current = updateFloatingGeometry(gesture.initial, gesture.mode, event.clientX - gesture.startX, event.clientY - gesture.startY, bounds.width, bounds.height);
    this.applyGeometry(gesture.window, gesture.current);
    event.preventDefault();
  }

  private finishGesture(event: PointerEvent, cancelled: boolean): void {
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (!cancelled) this.moveGesture(event);
    this.endGesture();
    if (cancelled) this.applyGeometry(gesture.window, gesture.initial);
    else this.commitGeometry(gesture.id, gesture.current);
  }

  private cancelGesture(): void {
    const gesture = this.gesture;
    if (!gesture) return;
    this.endGesture();
    this.applyGeometry(gesture.window, gesture.initial);
  }

  private endGesture(): void {
    const gesture = this.gesture;
    if (!gesture) return;
    this.gesture = null;
    gesture.target.removeEventListener('lostpointercapture', this.handleLostPointerCapture);
    window.removeEventListener('pointermove', this.handlePointerMove, true);
    window.removeEventListener('pointerup', this.handlePointerUp, true);
    window.removeEventListener('pointercancel', this.handlePointerCancel, true);
    window.removeEventListener('blur', this.handleWindowBlur);
    gesture.shield.remove();
    try { gesture.target.releasePointerCapture(gesture.pointerId); } catch { /* Capture may already be lost. */ }
  }

  private constrainWindows(): void {
    if (this.gesture) return;
    const bounds = this.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    for (const [id, record] of this.records) {
      const element = record.window;
      if (!element || element.hidden) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const original = { x: rect.left - bounds.left, y: rect.top - bounds.top, width: rect.width, height: rect.height };
      const next = constrainGeometry(original, bounds.width, bounds.height);
      if (Object.keys(next).every((key) => Math.abs(next[key as keyof Geometry] - original[key as keyof Geometry]) < 0.5)) continue;
      this.applyGeometry(element, next);
      this.commitGeometry(id, next);
    }
  }

  private applyGeometry(element: HTMLElement, geometry: Geometry): void {
    element.style.left = `${geometry.x}px`;
    element.style.top = `${geometry.y}px`;
    element.style.width = `${geometry.width}px`;
    element.style.height = `${geometry.height}px`;
  }

  private commitGeometry(id: string, geometry: Geometry): void {
    this.dispatchEvent(new CustomEvent('ce-floating-panel-geometry', {
      bubbles: true,
      composed: true,
      detail: { panelInstanceId: id, position: { x: geometry.x, y: geometry.y }, size: { width: geometry.width, height: geometry.height } },
    }));
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
    && item.state === 'open';
}

function setOptionalAttribute(element: Element, name: string, value: string | undefined): void {
  if (value === undefined) {
    if (element.hasAttribute(name)) element.removeAttribute(name);
  } else if (element.getAttribute(name) !== value) {
    element.setAttribute(name, value);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function constrainGeometry(geometry: Geometry, width: number, height: number): Geometry {
  const boundedWidth = clamp(geometry.width, Math.min(240, width), width);
  const boundedHeight = clamp(geometry.height, Math.min(180, height), height);
  return {
    x: clamp(geometry.x, 0, width - boundedWidth),
    y: clamp(geometry.y, 0, height - boundedHeight),
    width: boundedWidth,
    height: boundedHeight,
  };
}

export function updateFloatingGeometry(initial: Geometry, mode: GestureMode, dx: number, dy: number, width: number, height: number): Geometry {
  const start = constrainGeometry(initial, width, height);
  const minWidth = Math.min(240, width);
  const minHeight = Math.min(180, height);
  if (mode === 'move') {
    return { ...start, x: clamp(start.x + dx, 0, width - start.width), y: clamp(start.y + dy, 0, height - start.height) };
  }
  const nextHeight = clamp(start.height + dy, minHeight, height - start.y);
  if (mode === 'resize-left') {
    const right = start.x + start.width;
    const nextWidth = clamp(start.width - dx, Math.min(minWidth, right), right);
    return { x: right - nextWidth, y: start.y, width: nextWidth, height: nextHeight };
  }
  return { ...start, width: clamp(start.width + dx, Math.min(minWidth, width - start.x), width - start.x), height: nextHeight };
}

function escapeSelector(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/([\\"\[\]#.])/g, '\\$1');
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
