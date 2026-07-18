export class Divider extends HTMLElement {
  private dragging = false;
  private startCoord = 0;
  private dragShield: HTMLElement | null = null;
  private moveHandler = (event: PointerEvent) => this.handlePointerMove(event);
  private upHandler = () => this.handlePointerUp();

  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
    }
    this.render();
  }

  disconnectedCallback() {
    this.removeDocumentListeners();
    this.removeDragShield();
  }

  private getDirection(): 'row' | 'column' {
    const parent = this.parentElement;
    if (parent?.tagName.toLowerCase() === 'ce-split-pane') {
      return parent.getAttribute('direction') === 'column' ? 'column' : 'row';
    }
    return 'row';
  }

  private render() {
    const direction = this.getDirection();
    const cursor = direction === 'row' ? 'col-resize' : 'row-resize';
    const hitArea = 'var(--ce-divider-hit-area, var(--divider-hit-area, 6px))';
    const size = 'var(--ce-divider-size, var(--divider-size, 2px))';
    const width = direction === 'row' ? hitArea : '100%';
    const height = direction === 'column' ? hitArea : '100%';
    const padding = direction === 'row'
      ? `0 calc((${hitArea} - ${size}) / 2)`
      : `calc((${hitArea} - ${size}) / 2) 0`;
    this.style.cursor = cursor;

    this.shadowRoot!.innerHTML = `
      <style>
        :host {
          display: flex;
          flex-shrink: 0;
          cursor: ${cursor};
          user-select: none;
          border: 0;
          outline: 0;
        }
        .bar {
          width: ${width};
          height: ${height};
          padding: ${padding};
          box-sizing: border-box;
          border: 0;
          outline: 0;
          background-clip: content-box;
          background-color: var(--ce-divider-color, var(--ce-border, #444));
          transition: background-color 0.15s;
        }
        .bar:hover {
          background-color: var(--ce-divider-hover-color, var(--ce-accent, #569cd6));
        }
        .bar.dragging {
          background-color: var(--ce-divider-active-color, var(--ce-divider-hover-color, var(--ce-accent, #569cd6)));
        }
      </style>
      <div class="bar" role="separator" aria-orientation="${direction === 'row' ? 'vertical' : 'horizontal'}"></div>
    `;

    this.shadowRoot!.querySelector('.bar')!.addEventListener('pointerdown', (event) => {
      const pointerEvent = event as PointerEvent;
      pointerEvent.preventDefault();
      this.dragging = true;
      this.startCoord = this.getDirection() === 'row' ? pointerEvent.clientX : pointerEvent.clientY;
      (event.currentTarget as HTMLElement).classList.add('dragging');
      this.addDragShield();
      this.addDocumentListeners();
      this.dispatchEvent(new CustomEvent('ce-divider-drag-start', {
        bubbles: true,
        composed: true,
      }));
    });
  }

  private addDocumentListeners() {
    const doc = this.ownerDocument;
    doc.addEventListener('pointermove', this.moveHandler);
    doc.addEventListener('pointerup', this.upHandler);
    doc.addEventListener('pointercancel', this.upHandler);
  }

  private removeDocumentListeners() {
    const doc = this.ownerDocument;
    doc.removeEventListener('pointermove', this.moveHandler);
    doc.removeEventListener('pointerup', this.upHandler);
    doc.removeEventListener('pointercancel', this.upHandler);
  }

  private addDragShield() {
    this.removeDragShield();

    const doc = this.ownerDocument;
    const shield = doc.createElement('div');
    shield.setAttribute('data-ce-divider-drag-shield', '');
    Object.assign(shield.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483647',
      cursor: this.getDirection() === 'row' ? 'col-resize' : 'row-resize',
      background: 'transparent',
      userSelect: 'none',
    });
    doc.body.appendChild(shield);
    this.dragShield = shield;
  }

  private removeDragShield() {
    this.dragShield?.remove();
    this.dragShield = null;
  }

  private findResizablePanel(start: Element | null, step: 1 | -1): HTMLElement | null {
    let current = start;
    while (current) {
      if (current.tagName.toLowerCase() === 'ce-panel') {
        const type = current.getAttribute('type') || 'iframe';
        if (type === 'iframe') return current as HTMLElement;
      }
      current = step === 1
        ? current.nextElementSibling
        : current.previousElementSibling;
    }
    return null;
  }

  private handlePointerMove(event: PointerEvent) {
    if (!this.dragging) {
      return;
    }
    event.preventDefault();

    const currentCoord = this.getDirection() === 'row' ? event.clientX : event.clientY;
    const delta = currentCoord - this.startCoord;
    this.startCoord = currentCoord;

    const prevPanel = this.findResizablePanel(this.previousElementSibling, -1);
    const nextPanel = this.findResizablePanel(this.nextElementSibling, 1);

    this.dispatchEvent(new CustomEvent('ce-divider-resize', {
      detail: { delta, prevPanel, nextPanel },
      bubbles: true,
      composed: true,
    }));
  }

  private handlePointerUp() {
    if (!this.dragging) {
      return;
    }

    this.dragging = false;
    this.shadowRoot!.querySelector('.bar')?.classList.remove('dragging');
    this.removeDocumentListeners();
    this.removeDragShield();
    this.dispatchEvent(new CustomEvent('ce-divider-drag-end', {
      bubbles: true,
      composed: true,
    }));
  }
}

if (!customElements.get('ce-divider')) {
  customElements.define('ce-divider', Divider);
}
