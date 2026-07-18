import { describe, it, expect, afterEach } from 'vitest';
import '../../src/layout/split-pane';
import '../../src/layout/divider';
import '../../src/layout/panel';
import '../../src/layout/panel-group';
import type { Divider } from '../../src/layout/divider';

const PointerEventCtor = window.PointerEvent ?? MouseEvent;

describe('ce-divider', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders with shared ce divider sizing tokens and legacy fallbacks', () => {
    const el = document.createElement('ce-divider') as Divider;
    document.body.appendChild(el);

    const styles = el.shadowRoot!.querySelector('style')!.textContent || '';
    expect(el.shadowRoot!.querySelector('.bar')).not.toBeNull();
    expect(getComputedStyle(el).cursor).toBe('col-resize');
    expect(styles).toContain('var(--ce-divider-hit-area, var(--divider-hit-area, 6px))');
    expect(styles).toContain('var(--ce-divider-size, var(--divider-size, 2px))');
    expect(styles).toContain('var(--ce-divider-color, var(--ce-border, #444))');
    expect(styles).toContain('var(--ce-divider-hover-color, var(--ce-accent, #569cd6))');
    expect(styles).toContain('var(--ce-divider-active-color, var(--ce-divider-hover-color, var(--ce-accent, #569cd6)))');
  });

  it('uses row resize cursor inside column split panes', () => {
    const pane = document.createElement('ce-split-pane');
    pane.setAttribute('direction', 'column');
    const el = document.createElement('ce-divider') as Divider;
    pane.appendChild(el);
    document.body.appendChild(pane);

    expect(getComputedStyle(el).cursor).toBe('row-resize');
  });

  it('dispatches ce-divider-resize on drag', async () => {
    const pane = document.createElement('ce-split-pane');
    const left = document.createElement('ce-panel');
    const el = document.createElement('ce-divider') as Divider;
    const right = document.createElement('ce-panel');
    pane.appendChild(left);
    pane.appendChild(el);
    pane.appendChild(right);
    document.body.appendChild(pane);

    const detailPromise = new Promise<any>((resolve) => {
      el.addEventListener('ce-divider-resize', ((event: CustomEvent) => {
        resolve(event.detail);
      }) as EventListener);
    });

    const bar = el.shadowRoot!.querySelector('.bar') as HTMLElement;
    bar.dispatchEvent(new PointerEventCtor('pointerdown', { clientX: 100, clientY: 0, bubbles: true }));
    document.dispatchEvent(new PointerEventCtor('pointermove', { clientX: 150, clientY: 0, bubbles: true }));
    document.dispatchEvent(new PointerEventCtor('pointerup', { clientX: 150, clientY: 0, bubbles: true }));

    const detail = await detailPromise;
    expect(detail.delta).toBe(50);
    expect(detail.prevPanel).toBe(left);
    expect(detail.nextPanel).toBe(right);
  });

  it('dispatches resize even when adjacent elements are layout containers', async () => {
    const pane = document.createElement('ce-split-pane');
    const group = document.createElement('ce-panel-group');
    const divider = document.createElement('ce-divider') as Divider;
    const nestedPane = document.createElement('ce-split-pane');
    pane.appendChild(group);
    pane.appendChild(divider);
    pane.appendChild(nestedPane);
    document.body.appendChild(pane);

    const detailPromise = new Promise<any>((resolve) => {
      divider.addEventListener('ce-divider-resize', ((event: CustomEvent) => {
        resolve(event.detail);
      }) as EventListener);
    });

    const bar = divider.shadowRoot!.querySelector('.bar') as HTMLElement;
    bar.dispatchEvent(new PointerEventCtor('pointerdown', { clientX: 100, clientY: 0, bubbles: true }));
    document.dispatchEvent(new PointerEventCtor('pointermove', { clientX: 140, clientY: 0, bubbles: true }));
    document.dispatchEvent(new PointerEventCtor('pointerup', { clientX: 140, clientY: 0, bubbles: true }));

    const detail = await detailPromise;
    expect(detail.delta).toBe(40);
    expect(detail.prevPanel).toBeNull();
    expect(detail.nextPanel).toBeNull();
  });

  it('uses a document-level drag shield while dragging', () => {
    const pane = document.createElement('ce-split-pane');
    const left = document.createElement('ce-panel');
    const divider = document.createElement('ce-divider') as Divider;
    const right = document.createElement('ce-panel');
    pane.append(left, divider, right);
    document.body.appendChild(pane);

    const bar = divider.shadowRoot!.querySelector('.bar') as HTMLElement;
    bar.dispatchEvent(new PointerEventCtor('pointerdown', { clientX: 100, clientY: 0, bubbles: true }));

    const shield = document.querySelector('[data-ce-divider-drag-shield]') as HTMLElement | null;
    expect(shield).not.toBeNull();
    expect(shield!.style.position).toBe('fixed');
    expect(shield!.style.cursor).toBe('col-resize');

    document.dispatchEvent(new PointerEventCtor('pointerup', { clientX: 100, clientY: 0, bubbles: true }));
    expect(document.querySelector('[data-ce-divider-drag-shield]')).toBeNull();
  });

  describe('skip simple panels', () => {
    it('skips type=simple panel and includes resizable panel refs in event', async () => {
      const pane = document.createElement('ce-split-pane');
      pane.setAttribute('direction', 'column');

      const editor = document.createElement('ce-panel');
      editor.setAttribute('type', 'iframe');
      editor.style.height = '200px';

      const divider = document.createElement('ce-divider') as Divider;

      const terminal = document.createElement('ce-panel');
      terminal.setAttribute('type', 'iframe');
      terminal.style.height = '100px';

      const status = document.createElement('ce-panel');
      status.setAttribute('type', 'simple');
      status.style.height = '22px';

      pane.appendChild(editor);
      pane.appendChild(divider);
      pane.appendChild(terminal);
      pane.appendChild(status);
      document.body.appendChild(pane);

      const detailPromise = new Promise<any>((resolve) => {
        divider.addEventListener('ce-divider-resize', ((event: CustomEvent) => {
          resolve(event.detail);
        }) as EventListener);
      });

      const bar = divider.shadowRoot!.querySelector('.bar') as HTMLElement;
      bar.dispatchEvent(new PointerEventCtor('pointerdown', { clientX: 0, clientY: 200, bubbles: true }));
      document.dispatchEvent(new PointerEventCtor('pointermove', { clientX: 0, clientY: 230, bubbles: true }));
      document.dispatchEvent(new PointerEventCtor('pointerup', { clientX: 0, clientY: 230, bubbles: true }));

      const detail = await detailPromise;
      expect(detail.prevPanel).toBe(editor);
      expect(detail.nextPanel).toBe(terminal);
      expect(detail.delta).toBe(30);
    });

    it('dispatches resize with null panel refs when both sides are simple panels', async () => {
      const pane = document.createElement('ce-split-pane');
      pane.setAttribute('direction', 'column');

      const top = document.createElement('ce-panel');
      top.setAttribute('type', 'simple');
      top.style.height = '22px';

      const divider = document.createElement('ce-divider') as Divider;

      const bottom = document.createElement('ce-panel');
      bottom.setAttribute('type', 'simple');
      bottom.style.height = '22px';

      pane.appendChild(top);
      pane.appendChild(divider);
      pane.appendChild(bottom);
      document.body.appendChild(pane);

      const detailPromise = new Promise<any>((resolve) => {
        divider.addEventListener('ce-divider-resize', ((event: CustomEvent) => {
          resolve(event.detail);
        }) as EventListener);
      });

      const bar = divider.shadowRoot!.querySelector('.bar') as HTMLElement;
      bar.dispatchEvent(new PointerEventCtor('pointerdown', { clientX: 0, clientY: 22, bubbles: true }));
      document.dispatchEvent(new PointerEventCtor('pointermove', { clientX: 0, clientY: 42, bubbles: true }));
      document.dispatchEvent(new PointerEventCtor('pointerup', { clientX: 0, clientY: 42, bubbles: true }));

      const detail = await detailPromise;
      expect(detail.delta).toBe(20);
      expect(detail.prevPanel).toBeNull();
      expect(detail.nextPanel).toBeNull();
    });

    it('dispatches resize with partial panel refs when only one side has iframe panel', async () => {
      const pane = document.createElement('ce-split-pane');
      pane.setAttribute('direction', 'column');

      const simple = document.createElement('ce-panel');
      simple.setAttribute('type', 'simple');
      simple.style.height = '22px';

      const divider = document.createElement('ce-divider') as Divider;

      const iframe = document.createElement('ce-panel');
      iframe.setAttribute('type', 'iframe');
      iframe.style.height = '100px';

      pane.appendChild(simple);
      pane.appendChild(divider);
      pane.appendChild(iframe);
      document.body.appendChild(pane);

      const detailPromise = new Promise<any>((resolve) => {
        divider.addEventListener('ce-divider-resize', ((event: CustomEvent) => {
          resolve(event.detail);
        }) as EventListener);
      });

      const bar = divider.shadowRoot!.querySelector('.bar') as HTMLElement;
      bar.dispatchEvent(new PointerEventCtor('pointerdown', { clientX: 0, clientY: 22, bubbles: true }));
      document.dispatchEvent(new PointerEventCtor('pointermove', { clientX: 0, clientY: 42, bubbles: true }));
      document.dispatchEvent(new PointerEventCtor('pointerup', { clientX: 0, clientY: 42, bubbles: true }));

      const detail = await detailPromise;
      expect(detail.delta).toBe(20);
      expect(detail.prevPanel).toBeNull();
      expect(detail.nextPanel).toBe(iframe);
    });
  });
});
