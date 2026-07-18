import { describe, it, expect, afterEach } from 'vitest';
import '../../examples/layout-kit';

const PointerEventCtor = window.PointerEvent ?? MouseEvent;

describe('layout-kit-page', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('resizes the previous panel when a divider emits resize', () => {
    const page = document.createElement('layout-kit-page');
    document.body.appendChild(page);

    const divider = page.querySelector('ce-divider')!;
    const panel = divider.previousElementSibling as HTMLElement;

    divider.dispatchEvent(new CustomEvent('ce-divider-resize', {
      detail: { delta: 50 },
      bubbles: true,
      composed: true,
    }));

    expect(panel.style.flex).toBe('0 1 290px');
  });

  it('renders nested split panes inside panels', () => {
    const page = document.createElement('layout-kit-page');
    document.body.appendChild(page);

    expect(page.querySelector('[data-example="ide-shell"]')).not.toBeNull();
    expect(page.querySelector('[data-example="workbench-column"]')).not.toBeNull();
    expect(page.querySelector('[data-example="bottom-tools"]')).not.toBeNull();
    expect(page.querySelector('[data-panel="editor-tabs"]')).toBeInstanceOf(HTMLElement);
  });

  it('uses panel groups instead of tabs nested inside panels', () => {
    const page = document.createElement('layout-kit-page');
    document.body.appendChild(page);

    expect(page.querySelector('.panel-tab')).toBeNull();
    expect(page.querySelector('ce-panel ce-tabs')).toBeNull();
    expect(page.querySelector('[data-panel="explorer"]')?.tagName.toLowerCase()).toBe('ce-panel-group');
    expect(page.querySelector('[data-panel="terminal"]')?.tagName.toLowerCase()).toBe('ce-panel-group');
    expect(page.querySelector('[data-panel="problems"]')?.tagName.toLowerCase()).toBe('ce-panel-group');
    expect(page.querySelector('[data-panel="inspector"]')?.tagName.toLowerCase()).toBe('ce-panel-group');
    expect(page.querySelectorAll('[data-panel="explorer"] > ce-panel')).toHaveLength(2);
  });

  it('uses document-style tabs for editor files only', () => {
    const page = document.createElement('layout-kit-page');
    document.body.appendChild(page);

    expect(page.querySelector('[data-panel="editor-tabs"]')?.getAttribute('variant')).toBe('document');
    expect(page.querySelector('[data-panel="explorer"]')?.hasAttribute('variant')).toBe(false);
    expect(page.querySelector('[data-panel="terminal"]')?.hasAttribute('variant')).toBe(false);
  });

  it('renders a model-driven tab drag and drop demo', () => {
    const page = document.createElement('layout-kit-page');
    document.body.appendChild(page);

    const demo = page.querySelector('[data-example="tab-dnd-demo"]') as HTMLElement;
    const groups = Array.from(demo.querySelectorAll('ce-panel-group')) as HTMLElement[];

    expect(demo).toBeInstanceOf(HTMLElement);
    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.dataset.groupId)).toBe(true);
    expect(groups.every((group) => group.dataset.sessionId === 'layout-kit-demo-session')).toBe(true);
    expect(groups.every((group) => group.dataset.windowId === 'layout-kit-main')).toBe(true);
    expect(groups[0].querySelector(':scope > ce-panel')?.getAttribute('data-tab-id')).toBeTruthy();
  });

  it('moves tabs inside the layout-kit drag demo', () => {
    const page = document.createElement('layout-kit-page');
    document.body.appendChild(page);

    const demo = page.querySelector('[data-example="tab-dnd-demo"]') as HTMLElement;
    const groups = Array.from(demo.querySelectorAll('ce-panel-group')) as HTMLElement[];
    const sourceGroup = groups[0];
    const targetGroup = groups[1];
    const sourceTab = sourceGroup.shadowRoot!.querySelectorAll('.tab-item')[1] as HTMLElement;
    const targetTab = targetGroup.shadowRoot!.querySelector('.tab-item') as HTMLElement;
    const tabBar = targetGroup.shadowRoot!.querySelector('.tab-bar') as HTMLElement;
    const content = targetGroup.shadowRoot!.querySelector('.content') as HTMLElement;

    targetTab.getBoundingClientRect = () => ({ ...makeRect(80, 32), left: 100, right: 180, top: 0, bottom: 32, x: 100, y: 0 } as DOMRect);
    tabBar.getBoundingClientRect = () => ({ ...makeRect(160, 32), left: 100, right: 260, top: 0, bottom: 32, x: 100, y: 0 } as DOMRect);
    content.getBoundingClientRect = () => ({ ...makeRect(160, 200), left: 100, right: 260, top: 32, bottom: 232, x: 100, y: 32 } as DOMRect);

    sourceTab.dispatchEvent(new PointerEventCtor('pointerdown', { clientX: 20, clientY: 16, bubbles: true, composed: true }));
    document.dispatchEvent(new PointerEventCtor('pointermove', { clientX: 110, clientY: 16, bubbles: true }));
    document.dispatchEvent(new PointerEventCtor('pointerup', { clientX: 110, clientY: 16, bubbles: true }));

    const refreshedTarget = (Array.from(demo.querySelectorAll('ce-panel-group')) as HTMLElement[])
      .find((group) => group.dataset.groupId === targetGroup.dataset.groupId)!;
    const titles = Array.from(refreshedTarget.querySelectorAll(':scope > ce-panel')).map((panel) => panel.getAttribute('title'));
    expect(titles).toEqual(['Outline', 'Main', 'Preview']);
    expect(refreshedTarget.querySelector(':scope > ce-panel[active]')?.getAttribute('title')).toBe('Outline');
  });

  it('makes demo content scroll instead of stretching panels', () => {
    const page = document.createElement('layout-kit-page');
    document.body.appendChild(page);

    const styles = page.shadowRoot ? '' : page.querySelector('style')!.textContent || '';
    expect(styles).toContain('.code-preview');
    expect(styles).toContain('overflow: auto');
    expect(styles).toContain('overflow-wrap: anywhere');
  });

  it('uses shrinkable flex bases for terminal and problems panels', () => {
    const page = document.createElement('layout-kit-page');
    document.body.appendChild(page);

    const terminal = page.querySelector('[data-panel="terminal"]') as HTMLElement;
    const problems = page.querySelector('[data-panel="problems"]') as HTMLElement;

    expect(terminal.style.flex).toBe('1 1 320px');
    expect(problems.style.flex).toBe('1 1 220px');
    expect(terminal.style.getPropertyValue('--panel-min-width').trim()).toBe('140px');
    expect(problems.style.getPropertyValue('--panel-min-width').trim()).toBe('120px');
  });

  it('renders a mixed simple and iframe panel example', () => {
    const page = document.createElement('layout-kit-page');
    document.body.appendChild(page);

    const mixed = page.querySelector('[data-example="simple-iframe-mixed"]') as HTMLElement;
    const simple = page.querySelector('[data-panel="simple-status"]') as HTMLElement;
    const iframePanel = page.querySelector('[data-panel="iframe-plugin"]') as HTMLElement;

    expect(mixed).toBeInstanceOf(HTMLElement);
    expect(mixed.getAttribute('direction')).toBe('column');
    expect(simple.tagName.toLowerCase()).toBe('ce-panel');
    expect(simple.getAttribute('type')).toBe('simple');
    expect(simple.style.flex).toBe('0 0 32px');
    expect(iframePanel.getAttribute('src')).toContain('data:text/html');
    expect(iframePanel.shadowRoot?.querySelector('iframe')?.getAttribute('sandbox'))
      .toBe('allow-scripts allow-same-origin');
    expect(iframePanel.style.flex).toBe('1 1 160px');
    expect(mixed.querySelector('ce-divider')).toBeNull();
  });

  it('records aggregate minimum width for the nested workbench container', () => {
    const page = document.createElement('layout-kit-page');
    document.body.appendChild(page);

    const workbench = page.querySelector('[data-panel="workbench"]') as HTMLElement;
    const bottomTools = page.querySelector('[data-example="bottom-tools"]') as HTMLElement;
    const terminal = page.querySelector('[data-panel="terminal"]') as HTMLElement;
    const problems = page.querySelector('[data-panel="problems"]') as HTMLElement;
    const dividerWidth = 4;
    const expectedMinWidth = Number.parseFloat(terminal.style.getPropertyValue('--panel-min-width')) +
      Number.parseFloat(problems.style.getPropertyValue('--panel-min-width')) +
      dividerWidth;

    expect(bottomTools.dataset.minWidth).toBe(`${expectedMinWidth}`);
    expect(workbench.dataset.minWidth).toBe(`${expectedMinWidth}`);
    expect(workbench.style.getPropertyValue('--layout-min-width').trim()).toBe(`${expectedMinWidth}px`);
    expect(workbench.style.flex).toBe('1 1 520px');
  });

  it('records aggregate minimum width for nested split panes', () => {
    const page = document.createElement('layout-kit-page');
    document.body.appendChild(page);

    const workbenchRow = page.querySelector('[data-example="workbench-row"]') as HTMLElement;

    expect(workbenchRow.dataset.minWidth).toBe('408');
    expect(workbenchRow.style.minWidth).toBe('408px');
  });

  it('supports resizing by simulating a real divider drag', () => {
    const page = document.createElement('layout-kit-page');
    document.body.appendChild(page);

    const divider = page.querySelector('[data-example="ide-shell"] > ce-divider')!;
    const panel = divider.previousElementSibling as HTMLElement;
    const bar = divider.shadowRoot!.querySelector('.bar')!;

    bar.dispatchEvent(new PointerEventCtor('pointerdown', { clientX: 100, clientY: 0, bubbles: true }));
    document.dispatchEvent(new PointerEventCtor('pointermove', { clientX: 140, clientY: 0, bubbles: true }));
    document.dispatchEvent(new PointerEventCtor('pointerup', { clientX: 140, clientY: 0, bubbles: true }));

    expect(panel.style.flex).toBe('0 1 280px');
  });

  it('keeps inspector inside the viewport when files are dragged far right', () => {
    const page = document.createElement('layout-kit-page');
    document.body.appendChild(page);

    const splitPane = page.querySelector('[data-example="ide-shell"]') as HTMLElement;
    const explorer = page.querySelector('[data-panel="explorer"]') as HTMLElement;
    const workbenchRow = page.querySelector('[data-example="workbench-row"]') as HTMLElement;
    const workbench = page.querySelector('[data-panel="workbench"]') as HTMLElement;
    const inspector = page.querySelector('[data-panel="inspector"]') as HTMLElement;
    const divider = splitPane.querySelector(':scope > ce-divider')!;

    splitPane.getBoundingClientRect = () => makeRect(1000, 600);
    explorer.getBoundingClientRect = () => makeRect(240, 600);
    workbenchRow.getBoundingClientRect = () => makeRect(756, 600);

    divider.dispatchEvent(new CustomEvent('ce-divider-resize', {
      detail: { delta: 1000 },
      bubbles: true,
      composed: true,
    }));

    expect(explorer.style.flex).toBe('0 1 588px');
    expect(workbenchRow.style.flex).toBe('0 1 408px');
    expect(workbench.style.flex).toBe('0 0 264px');
    expect(inspector.style.flex).toBe('0 0 140px');
  });

  it('shrinks workbench before inspector when files are dragged right', () => {
    const page = document.createElement('layout-kit-page');
    document.body.appendChild(page);

    const splitPane = page.querySelector('[data-example="ide-shell"]') as HTMLElement;
    const explorer = page.querySelector('[data-panel="explorer"]') as HTMLElement;
    const workbenchRow = page.querySelector('[data-example="workbench-row"]') as HTMLElement;
    const workbench = page.querySelector('[data-panel="workbench"]') as HTMLElement;
    const inspector = page.querySelector('[data-panel="inspector"]') as HTMLElement;
    const divider = splitPane.querySelector(':scope > ce-divider')!;

    splitPane.getBoundingClientRect = () => makeRect(1000, 600);
    explorer.getBoundingClientRect = () => makeRect(240, 600);
    workbenchRow.getBoundingClientRect = () => makeRect(756, 600);

    divider.dispatchEvent(new CustomEvent('ce-divider-resize', {
      detail: { delta: 100 },
      bubbles: true,
      composed: true,
    }));

    expect(explorer.style.flex).toBe('0 1 340px');
    expect(workbenchRow.style.flex).toBe('0 1 656px');
    expect(workbench.style.flex).toBe('0 0 420px');
    expect(inspector.style.flex).toBe('0 0 220px');
  });

  it('freezes inspector width before shrinking workbench when browser has measured sizes', () => {
    const page = document.createElement('layout-kit-page');
    document.body.appendChild(page);

    const splitPane = page.querySelector('[data-example="ide-shell"]') as HTMLElement;
    const explorer = page.querySelector('[data-panel="explorer"]') as HTMLElement;
    const workbenchRow = page.querySelector('[data-example="workbench-row"]') as HTMLElement;
    const workbench = page.querySelector('[data-panel="workbench"]') as HTMLElement;
    const inspector = page.querySelector('[data-panel="inspector"]') as HTMLElement;
    const divider = splitPane.querySelector(':scope > ce-divider')!;

    splitPane.getBoundingClientRect = () => makeRect(1000, 600);
    explorer.getBoundingClientRect = () => makeRect(240, 600);
    workbenchRow.getBoundingClientRect = () => makeRect(756, 600);
    workbench.getBoundingClientRect = () => makeRect(532, 600);
    inspector.getBoundingClientRect = () => makeRect(220, 600);

    divider.dispatchEvent(new CustomEvent('ce-divider-resize', {
      detail: { delta: 100 },
      bubbles: true,
      composed: true,
    }));

    expect(workbench.style.flex).toBe('0 0 432px');
    expect(inspector.style.flex).toBe('0 0 220px');
  });

  it('restores nested widths when files drag reverses before pointer up', () => {
    const page = document.createElement('layout-kit-page');
    document.body.appendChild(page);

    const splitPane = page.querySelector('[data-example="ide-shell"]') as HTMLElement;
    const explorer = page.querySelector('[data-panel="explorer"]') as HTMLElement;
    const workbenchRow = page.querySelector('[data-example="workbench-row"]') as HTMLElement;
    const workbench = page.querySelector('[data-panel="workbench"]') as HTMLElement;
    const inspector = page.querySelector('[data-panel="inspector"]') as HTMLElement;
    const divider = splitPane.querySelector(':scope > ce-divider')!;

    splitPane.getBoundingClientRect = () => makeRect(1000, 600);
    explorer.getBoundingClientRect = () => makeRect(240, 600);
    workbenchRow.getBoundingClientRect = () => makeRect(756, 600);
    workbench.getBoundingClientRect = () => makeRect(532, 600);
    inspector.getBoundingClientRect = () => makeRect(220, 600);

    divider.dispatchEvent(new CustomEvent('ce-divider-drag-start', {
      bubbles: true,
      composed: true,
    }));
    divider.dispatchEvent(new CustomEvent('ce-divider-resize', {
      detail: { delta: 500 },
      bubbles: true,
      composed: true,
    }));
    expect(workbench.style.flex).toBe('0 0 264px');
    expect(inspector.style.flex).toBe('0 0 140px');

    divider.dispatchEvent(new CustomEvent('ce-divider-resize', {
      detail: { delta: -400 },
      bubbles: true,
      composed: true,
    }));

    expect(explorer.style.flex).toBe('0 1 340px');
    expect(workbenchRow.style.flex).toBe('0 1 656px');
    expect(workbench.style.flex).toBe('0 0 432px');
    expect(inspector.style.flex).toBe('0 0 220px');
  });

  it('keeps inspector inside the viewport when files are dragged far left', () => {
    const page = document.createElement('layout-kit-page');
    document.body.appendChild(page);

    const splitPane = page.querySelector('[data-example="ide-shell"]') as HTMLElement;
    const explorer = page.querySelector('[data-panel="explorer"]') as HTMLElement;
    const workbenchRow = page.querySelector('[data-example="workbench-row"]') as HTMLElement;
    const divider = splitPane.querySelector(':scope > ce-divider')!;

    splitPane.getBoundingClientRect = () => makeRect(1000, 600);
    explorer.getBoundingClientRect = () => makeRect(240, 600);
    workbenchRow.getBoundingClientRect = () => makeRect(756, 600);

    divider.dispatchEvent(new CustomEvent('ce-divider-resize', {
      detail: { delta: -1000 },
      bubbles: true,
      composed: true,
    }));

    expect(explorer.style.flex).toBe('0 1 140px');
    expect(workbenchRow.style.flex).toBe('0 1 856px');
  });

  it('resizes the middle vertical editor area from a pixel basis', () => {
    const page = document.createElement('layout-kit-page');
    document.body.appendChild(page);

    const divider = page.querySelector('[data-example="workbench-column"] > ce-divider')!;
    const panel = divider.previousElementSibling as HTMLElement;
    const bar = divider.shadowRoot!.querySelector('.bar')!;

    bar.dispatchEvent(new PointerEventCtor('pointerdown', { clientX: 0, clientY: 100, bubbles: true }));
    document.dispatchEvent(new PointerEventCtor('pointermove', { clientX: 0, clientY: 130, bubbles: true }));
    document.dispatchEvent(new PointerEventCtor('pointerup', { clientX: 0, clientY: 130, bubbles: true }));

    expect(panel.style.flex).toBe('0 1 390px');
  });

  it('resizes the right inspector panel as the next target', () => {
    const page = document.createElement('layout-kit-page');
    document.body.appendChild(page);

    const divider = page.querySelector('[data-example="workbench-row"] > ce-divider[data-resize-target="next"]')!;
    const panel = divider.nextElementSibling as HTMLElement;
    const bar = divider.shadowRoot!.querySelector('.bar')!;

    bar.dispatchEvent(new PointerEventCtor('pointerdown', { clientX: 100, clientY: 0, bubbles: true }));
    document.dispatchEvent(new PointerEventCtor('pointermove', { clientX: 130, clientY: 0, bubbles: true }));
    document.dispatchEvent(new PointerEventCtor('pointerup', { clientX: 130, clientY: 0, bubbles: true }));

    expect(panel.style.flex).toBe('0 1 190px');
  });

  it('continues inspector resizing by shrinking explorer after workbench reaches minimum width', () => {
    const page = document.createElement('layout-kit-page');
    document.body.appendChild(page);

    const explorer = page.querySelector('[data-panel="explorer"]') as HTMLElement;
    const splitPane = page.querySelector('[data-example="workbench-row"]') as HTMLElement;
    const divider = splitPane.querySelector('ce-divider[data-resize-target="next"]')!;
    const panel = divider.nextElementSibling as HTMLElement;
    const bar = divider.shadowRoot!.querySelector('.bar')!;

    splitPane.getBoundingClientRect = () => ({
      width: 700,
      height: 400,
      x: 0,
      y: 0,
      top: 0,
      right: 700,
      bottom: 400,
      left: 0,
      toJSON: () => ({}),
    });

    bar.dispatchEvent(new PointerEventCtor('pointerdown', { clientX: 300, clientY: 0, bubbles: true }));
    document.dispatchEvent(new PointerEventCtor('pointermove', { clientX: 0, clientY: 0, bubbles: true }));
    document.dispatchEvent(new PointerEventCtor('pointerup', { clientX: 0, clientY: 0, bubbles: true }));

    expect(panel.style.flex).toBe('0 1 520px');
    expect(explorer.style.flex).toBe('0 1 152px');
  });

  it('stops cascading after explorer reaches minimum width', () => {
    const page = document.createElement('layout-kit-page');
    document.body.appendChild(page);

    const explorer = page.querySelector('[data-panel="explorer"]') as HTMLElement;
    const splitPane = page.querySelector('[data-example="workbench-row"]') as HTMLElement;
    const workbench = page.querySelector('[data-panel="workbench"]') as HTMLElement;
    const workbenchRow = page.querySelector('[data-example="workbench-row"]') as HTMLElement;
    const inspector = page.querySelector('[data-panel="inspector"]') as HTMLElement;
    const divider = splitPane.querySelector('ce-divider[data-resize-target="next"]')!;
    const panel = divider.nextElementSibling as HTMLElement;
    const bar = divider.shadowRoot!.querySelector('.bar')!;

    splitPane.getBoundingClientRect = () => ({
      width: 700,
      height: 400,
      x: 0,
      y: 0,
      top: 0,
      right: 700,
      bottom: 400,
      left: 0,
      toJSON: () => ({}),
    });
    workbench.getBoundingClientRect = () => makeRect(476, 400);
    inspector.getBoundingClientRect = () => makeRect(220, 400);

    bar.dispatchEvent(new PointerEventCtor('pointerdown', { clientX: 500, clientY: 0, bubbles: true }));
    document.dispatchEvent(new PointerEventCtor('pointermove', { clientX: 0, clientY: 0, bubbles: true }));

    expect(panel.style.flex).toBe('0 1 532px');
    expect(workbench.style.flex).toBe('0 1 264px');
    expect(workbenchRow.style.flex).toBe('0 1 800px');
    expect(explorer.style.flex).toBe('0 1 140px');

    document.dispatchEvent(new PointerEventCtor('pointerup', { clientX: 0, clientY: 0, bubbles: true }));
  });

  it('restores ancestor widths when inspector drag reverses before pointer up', () => {
    const page = document.createElement('layout-kit-page');
    document.body.appendChild(page);

    const explorer = page.querySelector('[data-panel="explorer"]') as HTMLElement;
    const splitPane = page.querySelector('[data-example="workbench-row"]') as HTMLElement;
    const workbench = page.querySelector('[data-panel="workbench"]') as HTMLElement;
    const inspector = page.querySelector('[data-panel="inspector"]') as HTMLElement;
    const divider = splitPane.querySelector('ce-divider[data-resize-target="next"]')!;

    splitPane.getBoundingClientRect = () => makeRect(700, 400);
    explorer.getBoundingClientRect = () => makeRect(240, 400);
    workbench.getBoundingClientRect = () => makeRect(476, 400);
    inspector.getBoundingClientRect = () => makeRect(220, 400);

    divider.dispatchEvent(new CustomEvent('ce-divider-drag-start', {
      bubbles: true,
      composed: true,
    }));
    divider.dispatchEvent(new CustomEvent('ce-divider-resize', {
      detail: { delta: -500 },
      bubbles: true,
      composed: true,
    }));
    expect(inspector.style.flex).toBe('0 1 532px');
    expect(explorer.style.flex).toBe('0 1 140px');

    divider.dispatchEvent(new CustomEvent('ce-divider-resize', {
      detail: { delta: 400 },
      bubbles: true,
      composed: true,
    }));

    expect(inspector.style.flex).toBe('0 1 320px');
    expect(workbench.style.flex).toBe('0 1 376px');
    expect(explorer.style.flex).toBe('0 1 240px');
  });

  it('normalizes pixel flex bases back to percentages after dragging ends', () => {
    const page = document.createElement('layout-kit-page');
    document.body.appendChild(page);

    const splitPane = page.querySelector('[data-example="workbench-row"]') as HTMLElement;
    const workbench = page.querySelector('[data-panel="workbench"]') as HTMLElement;
    const inspector = page.querySelector('[data-panel="inspector"]') as HTMLElement;
    const divider = splitPane.querySelector('ce-divider[data-resize-target="next"]')!;

    workbench.style.flex = '0 1 480px';
    inspector.style.flex = '0 1 220px';
    workbench.getBoundingClientRect = () => makeRect(480, 400);
    inspector.getBoundingClientRect = () => makeRect(220, 400);

    divider.dispatchEvent(new CustomEvent('ce-divider-drag-end', {
      bubbles: true,
      composed: true,
    }));

    expect(workbench.style.flex).toBe('0 1 68.5714%');
    expect(inspector.style.flex).toBe('0 1 31.4286%');
  });
});

function makeRect(width: number, height: number): DOMRect {
  return {
    width,
    height,
    x: 0,
    y: 0,
    top: 0,
    right: width,
    bottom: height,
    left: 0,
    toJSON: () => ({}),
  } as DOMRect;
}
