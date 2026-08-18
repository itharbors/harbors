import { describe, it, expect, afterEach, vi } from 'vitest';
import '../../src/layout/split-pane';
import '../../src/layout/panel-group';

describe('ce-panel-group', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('activates the first panel by default', () => {
    const group = document.createElement('ce-panel-group');
    group.innerHTML = `
      <ce-panel title="Files">Files content</ce-panel>
      <ce-panel title="Outline">Outline content</ce-panel>
    `;

    document.body.appendChild(group);

    const panels = group.querySelectorAll('ce-panel');
    expect(panels[0].hasAttribute('active')).toBe(true);
    expect(panels[1].hasAttribute('active')).toBe(false);
    expect(panels[0].hasAttribute('chromeless')).toBe(true);
  });

  it('switches active panels when a group tab is clicked', () => {
    const group = document.createElement('ce-panel-group');
    group.innerHTML = `
      <ce-panel title="Files" active>Files content</ce-panel>
      <ce-panel title="Outline">Outline content</ce-panel>
    `;

    document.body.appendChild(group);
    const tab = group.shadowRoot!.querySelectorAll('.tab-item')[1] as HTMLElement;
    tab.click();

    const panels = group.querySelectorAll('ce-panel');
    expect(panels[0].hasAttribute('active')).toBe(false);
    expect(panels[1].hasAttribute('active')).toBe(true);
  });

  it('keeps the touched tab connected on pointerdown and switches on pointerup', () => {
    const group = document.createElement('ce-panel-group');
    group.innerHTML = '<ce-panel title="Files" active></ce-panel><ce-panel title="Outline"></ce-panel>';
    document.body.appendChild(group);

    const tab = group.shadowRoot!.querySelectorAll('.tab-item')[1] as HTMLElement;
    tab.dispatchEvent(pointerEvent('pointerdown', {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 40,
      clientY: 10,
    }));

    expect(group.querySelectorAll('ce-panel')[0].hasAttribute('active')).toBe(true);
    expect(tab.isConnected).toBe(true);

    tab.dispatchEvent(pointerEvent('pointerup', {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 40,
      clientY: 10,
    }));

    expect(group.querySelectorAll('ce-panel')[1].hasAttribute('active')).toBe(true);
  });

  it('switches active panels on a mouse pointer release', () => {
    const group = document.createElement('ce-panel-group');
    group.innerHTML = '<ce-panel title="Files" active></ce-panel><ce-panel title="Outline"></ce-panel>';
    document.body.appendChild(group);

    const tab = group.shadowRoot!.querySelectorAll('.tab-item')[1] as HTMLElement;
    tab.dispatchEvent(pointerEvent('pointerdown', {
      pointerId: 2,
      pointerType: 'mouse',
      clientX: 80,
      clientY: 10,
    }));
    tab.dispatchEvent(pointerEvent('pointerup', {
      pointerId: 2,
      pointerType: 'mouse',
      clientX: 80,
      clientY: 10,
    }));

    expect(group.querySelectorAll('ce-panel')[1].hasAttribute('active')).toBe(true);
  });

  it('does not switch active panels after the pointer moves past the drag threshold', () => {
    const group = document.createElement('ce-panel-group');
    group.innerHTML = '<ce-panel title="Files" active></ce-panel><ce-panel title="Outline"></ce-panel>';
    document.body.appendChild(group);

    const tab = group.shadowRoot!.querySelectorAll('.tab-item')[1] as HTMLElement;
    tab.dispatchEvent(pointerEvent('pointerdown', {
      pointerId: 3,
      pointerType: 'touch',
      clientX: 20,
      clientY: 10,
    }));
    tab.dispatchEvent(pointerEvent('pointermove', {
      pointerId: 3,
      pointerType: 'touch',
      clientX: 40,
      clientY: 10,
    }));
    tab.dispatchEvent(pointerEvent('pointerup', {
      pointerId: 3,
      pointerType: 'touch',
      clientX: 40,
      clientY: 10,
    }));

    const panels = group.querySelectorAll('ce-panel');
    expect(panels[0].hasAttribute('active')).toBe(true);
    expect(panels[1].hasAttribute('active')).toBe(false);
  });

  it('treats movement exactly at the drag threshold as a drag and suppresses the synthetic click', () => {
    const group = document.createElement('ce-panel-group');
    group.innerHTML = '<ce-panel title="Files" active></ce-panel><ce-panel title="Outline"></ce-panel>';
    document.body.appendChild(group);

    const tab = group.shadowRoot!.querySelectorAll('.tab-item')[1] as HTMLElement;
    tab.dispatchEvent(pointerEvent('pointerdown', {
      pointerId: 4,
      pointerType: 'touch',
      clientX: 20,
      clientY: 10,
    }));
    tab.dispatchEvent(pointerEvent('pointermove', {
      pointerId: 4,
      pointerType: 'touch',
      clientX: 32,
      clientY: 10,
    }));
    tab.dispatchEvent(pointerEvent('pointerup', {
      pointerId: 4,
      pointerType: 'touch',
      clientX: 32,
      clientY: 10,
    }));
    tab.click();

    const panels = group.querySelectorAll('ce-panel');
    expect(panels[0].hasAttribute('active')).toBe(true);
    expect(panels[1].hasAttribute('active')).toBe(false);
  });

  it('does not let a second pointer replace the active tab gesture', () => {
    const group = document.createElement('ce-panel-group');
    group.innerHTML = '<ce-panel title="Files" active></ce-panel><ce-panel title="Outline"></ce-panel>';
    document.body.appendChild(group);

    const tabs = group.shadowRoot!.querySelectorAll('.tab-item');
    const outlineTab = tabs[1] as HTMLElement;
    outlineTab.dispatchEvent(pointerEvent('pointerdown', {
      pointerId: 5,
      pointerType: 'touch',
      clientX: 40,
      clientY: 10,
      isPrimary: true,
    }));
    (tabs[0] as HTMLElement).dispatchEvent(pointerEvent('pointerdown', {
      pointerId: 6,
      pointerType: 'touch',
      clientX: 10,
      clientY: 10,
      isPrimary: false,
    }));
    (tabs[0] as HTMLElement).dispatchEvent(pointerEvent('pointerup', {
      pointerId: 6,
      pointerType: 'touch',
      clientX: 10,
      clientY: 10,
    }));
    outlineTab.dispatchEvent(pointerEvent('pointerup', {
      pointerId: 5,
      pointerType: 'touch',
      clientX: 40,
      clientY: 10,
    }));

    expect(group.querySelectorAll('ce-panel')[1].hasAttribute('active')).toBe(true);
  });

  it('does not require pointer capture for a tab gesture', () => {
    const group = document.createElement('ce-panel-group');
    group.innerHTML = '<ce-panel title="Files" active></ce-panel><ce-panel title="Outline"></ce-panel>';
    document.body.appendChild(group);

    const tab = group.shadowRoot!.querySelectorAll('.tab-item')[1] as HTMLElement;
    const setPointerCapture = vi.fn();
    tab.setPointerCapture = setPointerCapture;
    tab.dispatchEvent(pointerEvent('pointerdown', {
      pointerId: 7,
      pointerType: 'touch',
      clientX: 40,
      clientY: 10,
    }));

    expect(setPointerCapture).not.toHaveBeenCalled();
  });

  it('allows the native click after a pointer is cancelled', () => {
    const group = document.createElement('ce-panel-group');
    group.innerHTML = '<ce-panel title="Files" active></ce-panel><ce-panel title="Outline"></ce-panel>';
    document.body.appendChild(group);

    const tab = group.shadowRoot!.querySelectorAll('.tab-item')[1] as HTMLElement;
    tab.dispatchEvent(pointerEvent('pointerdown', {
      pointerId: 8,
      pointerType: 'touch',
      clientX: 40,
      clientY: 10,
    }));
    tab.dispatchEvent(pointerEvent('pointercancel', {
      pointerId: 8,
      pointerType: 'touch',
      clientX: 40,
      clientY: 10,
    }));
    tab.click();

    expect(group.querySelectorAll('ce-panel')[1].hasAttribute('active')).toBe(true);
  });

  it('recovers a stale gesture on a new primary pointerdown', () => {
    const group = document.createElement('ce-panel-group');
    group.innerHTML = '<ce-panel title="Files" active></ce-panel><ce-panel title="Outline"></ce-panel>';
    document.body.appendChild(group);

    const tab = group.shadowRoot!.querySelectorAll('.tab-item')[1] as HTMLElement;
    tab.dispatchEvent(pointerEvent('pointerdown', {
      pointerId: 9,
      pointerType: 'touch',
      clientX: 40,
      clientY: 10,
    }));
    const recoveryDown = pointerEvent('pointerdown', {
      pointerId: 10,
      pointerType: 'touch',
      clientX: 40,
      clientY: 10,
    });
    Object.defineProperty(recoveryDown, 'isPrimary', { value: true });
    tab.dispatchEvent(recoveryDown);
    tab.dispatchEvent(pointerEvent('pointerup', {
      pointerId: 10,
      pointerType: 'touch',
      clientX: 40,
      clientY: 10,
    }));

    expect(group.querySelectorAll('ce-panel')[1].hasAttribute('active')).toBe(true);
  });

  it('uses touchend as a click fallback without activating after horizontal movement', () => {
    const group = document.createElement('ce-panel-group');
    group.innerHTML = '<ce-panel title="Files" active></ce-panel><ce-panel title="Outline"></ce-panel>';
    document.body.appendChild(group);

    const tab = group.shadowRoot!.querySelectorAll('.tab-item')[1] as HTMLElement;
    tab.dispatchEvent(touchEvent('touchstart', 12, 20, 10));
    tab.dispatchEvent(touchEvent('touchend', 12, 20, 10));
    expect(group.querySelectorAll('ce-panel')[1].hasAttribute('active')).toBe(true);

    const secondGroup = document.createElement('ce-panel-group');
    secondGroup.innerHTML = '<ce-panel title="Files" active></ce-panel><ce-panel title="Outline"></ce-panel>';
    document.body.appendChild(secondGroup);
    const movedTab = secondGroup.shadowRoot!.querySelectorAll('.tab-item')[1] as HTMLElement;
    movedTab.dispatchEvent(touchEvent('touchstart', 13, 20, 10));
    movedTab.dispatchEvent(touchEvent('touchmove', 13, 32, 10));
    movedTab.dispatchEvent(touchEvent('touchend', 13, 32, 10));
    expect(secondGroup.querySelectorAll('ce-panel')[0].hasAttribute('active')).toBe(true);
    expect(secondGroup.querySelectorAll('ce-panel')[1].hasAttribute('active')).toBe(false);
  });

  it('deduplicates both native touch/pointer event orderings', () => {
    const first = document.createElement('ce-panel-group');
    first.innerHTML = '<ce-panel title="Files" active></ce-panel><ce-panel title="Outline"></ce-panel>';
    const firstEvents: Event[] = [];
    first.addEventListener('ce-panel-change', (event) => firstEvents.push(event));
    document.body.appendChild(first);
    const firstTab = first.shadowRoot!.querySelectorAll('.tab-item')[1] as HTMLElement;
    firstTab.dispatchEvent(touchEvent('touchstart', 21, 40, 10));
    firstTab.dispatchEvent(pointerEvent('pointerdown', {
      pointerId: 21,
      pointerType: 'touch',
      clientX: 40,
      clientY: 10,
    }));
    firstTab.dispatchEvent(pointerEvent('pointerup', {
      pointerId: 21,
      pointerType: 'touch',
      clientX: 40,
      clientY: 10,
    }));
    expect(firstTab.isConnected).toBe(false);
    const firstCurrentTab = first.shadowRoot!.querySelectorAll('.tab-item')[1] as HTMLElement;
    expect(firstCurrentTab).not.toBe(firstTab);
    firstCurrentTab.dispatchEvent(touchEvent('touchend', 21, 40, 10));
    firstCurrentTab.dispatchEvent(pointerEvent('pointerup', {
      pointerId: 21,
      pointerType: 'touch',
      clientX: 40,
      clientY: 10,
    }));
    firstCurrentTab.click();
    expect(firstEvents).toHaveLength(1);

    const second = document.createElement('ce-panel-group');
    second.innerHTML = '<ce-panel title="Files" active></ce-panel><ce-panel title="Outline"></ce-panel>';
    const secondEvents: Event[] = [];
    second.addEventListener('ce-panel-change', (event) => secondEvents.push(event));
    document.body.appendChild(second);
    const secondTab = second.shadowRoot!.querySelectorAll('.tab-item')[1] as HTMLElement;
    secondTab.dispatchEvent(touchEvent('touchstart', 22, 40, 10));
    secondTab.dispatchEvent(pointerEvent('pointerdown', {
      pointerId: 22,
      pointerType: 'touch',
      clientX: 40,
      clientY: 10,
    }));
    secondTab.dispatchEvent(touchEvent('touchend', 22, 40, 10));
    expect(secondTab.isConnected).toBe(false);
    const secondCurrentTab = second.shadowRoot!.querySelectorAll('.tab-item')[1] as HTMLElement;
    expect(secondCurrentTab).not.toBe(secondTab);
    secondCurrentTab.dispatchEvent(touchEvent('touchend', 22, 40, 10));
    secondCurrentTab.dispatchEvent(pointerEvent('pointerup', {
      pointerId: 22,
      pointerType: 'touch',
      clientX: 40,
      clientY: 10,
    }));
    secondCurrentTab.click();
    expect(secondEvents).toHaveLength(1);
  });

  it('recovers a new touch after cancelled or stale touch and pointer state', () => {
    const group = document.createElement('ce-panel-group');
    group.innerHTML = '<ce-panel title="Files" active></ce-panel><ce-panel title="Outline"></ce-panel>';
    document.body.appendChild(group);
    const tab = group.shadowRoot!.querySelectorAll('.tab-item')[1] as HTMLElement;

    tab.dispatchEvent(touchEvent('touchstart', 31, 20, 10));
    tab.dispatchEvent(pointerEvent('pointerdown', {
      pointerId: 31,
      pointerType: 'touch',
      clientX: 20,
      clientY: 10,
    }));
    tab.dispatchEvent(touchEvent('touchstart', 32, 20, 10, [
      { identifier: 31, clientX: 20, clientY: 10 },
      { identifier: 32, clientX: 20, clientY: 10 },
    ]));

    tab.dispatchEvent(touchEvent('touchstart', 34, 20, 10));
    tab.dispatchEvent(touchEvent('touchcancel', 34, 20, 10));
    tab.dispatchEvent(touchEvent('touchstart', 33, 20, 10));
    tab.dispatchEvent(pointerEvent('pointerdown', {
      pointerId: 33,
      pointerType: 'touch',
      isPrimary: true,
      clientX: 20,
      clientY: 10,
    }));
    tab.dispatchEvent(touchEvent('touchend', 33, 20, 10));
    tab.dispatchEvent(pointerEvent('pointerup', {
      pointerId: 33,
      pointerType: 'touch',
      clientX: 20,
      clientY: 10,
    }));

    expect(group.querySelectorAll('ce-panel')[1].hasAttribute('active')).toBe(true);
  });

  it('emits a panel change event', () => {
    const group = document.createElement('ce-panel-group');
    group.innerHTML = `
      <ce-panel title="Files" active>Files content</ce-panel>
      <ce-panel title="Outline">Outline content</ce-panel>
    `;
    const events: Array<{ title: string; index: number }> = [];
    group.addEventListener('ce-panel-change', ((event: CustomEvent<{ title: string; index: number }>) => {
      events.push(event.detail);
    }) as EventListener);

    document.body.appendChild(group);
    const tab = group.shadowRoot!.querySelectorAll('.tab-item')[1] as HTMLElement;
    tab.click();

    expect(events).toEqual([{ title: 'Outline', index: 1 }]);
  });

  it('prevents active panels and slots from stretching the group', () => {
    const group = document.createElement('ce-panel-group');
    group.innerHTML = `
      <ce-panel title="Files" active>Files content</ce-panel>
      <ce-panel title="Outline">Outline content</ce-panel>
    `;

    document.body.appendChild(group);

    const styles = group.shadowRoot!.querySelector('style')!.textContent || '';
    const contentBlock = styles.match(/\.content \{[\s\S]*?\}/)?.[0] || '';
    expect(styles).toContain(':host {');
    expect(styles).toContain('background: transparent');
    expect(styles).toContain('border: var(--ce-panel-group-border-width, 1px) solid var(--ce-panel-group-border-color, var(--ce-border, #444))');
    expect(styles).toContain('border-bottom: var(--ce-tabbar-border-width, 1px) solid var(--ce-tabbar-border-color, var(--ce-border, #444))');
    expect(styles).toContain('touch-action: pan-x');
    expect(contentBlock).toContain('.content {');
    expect(contentBlock).not.toContain('background:');
    expect(styles).toContain('.content slot');
    expect(styles).toContain('::slotted(ce-panel[active])');
    expect(styles).toContain('background: transparent');
    expect(styles).toContain('min-width: 0');
    expect(styles).toContain('overflow: hidden');
  });

  it('keeps a modal panel visible even when its tab is inactive', () => {
    const group = document.createElement('ce-panel-group');
    group.innerHTML = `
      <ce-panel title="Files" active>Files content</ce-panel>
      <ce-panel title="Dialog" modal-open>Dialog content</ce-panel>
    `;

    document.body.appendChild(group);

    const panels = group.querySelectorAll('ce-panel');
    const styles = group.shadowRoot!.querySelector('style')!.textContent || '';
    expect(panels[0].hasAttribute('active')).toBe(true);
    expect(panels[1].hasAttribute('active')).toBe(false);
    expect(panels[1].hasAttribute('modal-open')).toBe(true);
    expect(styles).toContain('::slotted(ce-panel[modal-open])');
    expect(styles).toMatch(/::slotted\(ce-panel\[modal-open\]\)\s*\{\s*display: flex/);
  });

  it('removes outer border when nested inside layout containers', () => {
    const splitPane = document.createElement('ce-split-pane');
    const group = document.createElement('ce-panel-group');
    group.innerHTML = '<ce-panel title="Files" active>Files content</ce-panel>';
    splitPane.appendChild(group);

    document.body.appendChild(splitPane);

    const styles = group.shadowRoot!.querySelector('style')!.textContent || '';
    expect(group.hasAttribute('layout-nested')).toBe(true);
    expect(styles).toContain(':host([layout-nested])');
    expect(styles).toContain('border: 0');
    expect(styles).toContain('border-radius: 0');
    expect(styles).toContain('var(--ce-tab-radius');
  });

  it('mirrors child tab ids onto rendered tab buttons', () => {
    const group = document.createElement('ce-panel-group');
    group.dataset.groupId = 'group-left';
    group.dataset.sessionId = 'session-a';
    group.innerHTML = `
      <ce-panel title="Files" data-tab-id="tab-files" active>Files content</ce-panel>
      <ce-panel title="Search" data-tab-id="tab-search">Search content</ce-panel>
    `;

    document.body.appendChild(group);

    const tabs = group.shadowRoot!.querySelectorAll('.tab-item');
    expect((tabs[0] as HTMLElement).dataset.tabId).toBe('tab-files');
    expect((tabs[1] as HTMLElement).dataset.tabId).toBe('tab-search');
  });

  it('leaves native dragging disabled so pointer dragging owns the gesture', () => {
    const group = document.createElement('ce-panel-group');
    group.innerHTML = `
      <ce-panel title="Files" data-tab-id="tab-files" active>Files content</ce-panel>
      <ce-panel title="Search" data-tab-id="tab-search">Search content</ce-panel>
    `;

    document.body.appendChild(group);

    const tabs = group.shadowRoot!.querySelectorAll('.tab-item');
    expect((tabs[0] as HTMLButtonElement).draggable).toBe(false);
    expect((tabs[1] as HTMLButtonElement).draggable).toBe(false);
  });

  it('marks tab bar and content with drop region hooks', () => {
    const group = document.createElement('ce-panel-group');
    group.innerHTML = '<ce-panel title="Files" data-tab-id="tab-files" active>Files content</ce-panel>';

    document.body.appendChild(group);

    expect(group.shadowRoot!.querySelector('.tab-bar')?.getAttribute('data-drop-region')).toBe('tab-strip');
    expect(group.shadowRoot!.querySelector('.content')?.getAttribute('data-drop-region')).toBe('panel-content');
  });

  it('renders insertion indicator when drop target attributes are present', () => {
    const group = document.createElement('ce-panel-group');
    group.setAttribute('data-drop-target-tab-id', 'tab-search');
    group.setAttribute('data-drop-placement', 'before');
    group.innerHTML = `
      <ce-panel title="Files" data-tab-id="tab-files" active>Files content</ce-panel>
      <ce-panel title="Search" data-tab-id="tab-search">Search content</ce-panel>
    `;

    document.body.appendChild(group);

    const indicator = group.shadowRoot!.querySelector('.drop-indicator') as HTMLElement | null;
    expect(indicator).not.toBeNull();
    expect(indicator?.dataset.targetTabId).toBe('tab-search');
    expect(indicator?.dataset.placement).toBe('before');
  });

  it('renders edge preview when drop edge attribute is present', () => {
    const group = document.createElement('ce-panel-group');
    group.setAttribute('data-drop-edge', 'left');
    group.innerHTML = '<ce-panel title="Files" data-tab-id="tab-files" active>Files content</ce-panel>';

    document.body.appendChild(group);

    const preview = group.shadowRoot!.querySelector('.drop-edge-preview') as HTMLElement | null;
    expect(preview).not.toBeNull();
    expect(preview?.dataset.edge).toBe('left');
  });

  it('uses shared tab and drop token fallbacks in styles', () => {
    const group = document.createElement('ce-panel-group');
    group.innerHTML = '<ce-panel title="Files" data-tab-id="tab-files" active>Files content</ce-panel>';

    document.body.appendChild(group);

    const styles = group.shadowRoot!.querySelector('style')!.textContent || '';
    expect(styles).toContain('var(--ce-tabbar-bg, var(--ce-surface-raised, #2d2d2d))');
    expect(styles).toContain('var(--ce-tab-bg-hover, var(--ce-surface, #1a1a1a))');
    expect(styles).toContain('var(--ce-drop-indicator-color, var(--ce-accent, #569cd6))');
    expect(styles).toContain('var(--ce-drop-zone-fill, color-mix(in srgb, var(--ce-accent, #569cd6) 18%, transparent))');
  });

  it('uses shared tab tokens for document variant colors and borders', () => {
    const group = document.createElement('ce-panel-group');
    group.setAttribute('variant', 'document');
    group.innerHTML = '<ce-panel title="Files" data-tab-id="tab-files" active>Files content</ce-panel>';

    document.body.appendChild(group);

    const styles = group.shadowRoot!.querySelector('style')!.textContent || '';
    expect(styles).toContain(':host([variant="document"]) .tab-bar');
    expect(styles).toContain('background: var(--ce-tabbar-bg, var(--ce-surface-raised, #2d2d2d));');
    expect(styles).toContain(':host([variant="document"]) .tab-item {');
    expect(styles).toContain('background: var(--ce-tab-bg, transparent);');
    expect(styles).toContain(':host([variant="document"]) .tab-item.active {');
    expect(styles).toContain('color: var(--ce-tab-fg-active, var(--ce-text-primary, #fff));');
    expect(styles).toContain('background: var(--ce-tab-bg-active, var(--ce-surface, #1a1a1a));');
    expect(styles).toContain('border-color: var(--ce-tab-separator, var(--ce-border, #444));');
    expect(styles).toContain('border-bottom-color: var(--ce-tab-bg-active, var(--ce-surface, #1a1a1a));');
  });
});

function pointerEvent(type: string, properties: {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
  isPrimary?: boolean;
}): PointerEvent {
  const event = new Event(type, { bubbles: true, composed: true }) as PointerEvent;
  for (const [key, value] of Object.entries(properties)) {
    Object.defineProperty(event, key, { value });
  }
  return event;
}

function touchEvent(
  type: string,
  identifier: number,
  clientX: number,
  clientY: number,
  activeTouches: Array<{ identifier: number; clientX: number; clientY: number }> = type === 'touchstart'
    ? [{ identifier, clientX, clientY }]
    : [],
): Event {
  const event = new Event(type, { bubbles: true, composed: true, cancelable: true });
  const touch = { identifier, clientX, clientY } as Touch;
  const touches = activeTouches.map((item) => ({
    identifier: item.identifier,
    clientX: item.clientX,
    clientY: item.clientY,
  } as Touch));
  const changedTouches = {
    length: 1,
    0: touch,
    item: (index: number) => index === 0 ? touch : null,
  } as unknown as TouchList;
  const activeTouchList = {
    length: touches.length,
    item: (index: number) => touches[index] ?? null,
  } as unknown as TouchList;
  touches.forEach((item, index) => Object.defineProperty(activeTouchList, index, { value: item }));
  Object.defineProperty(event, 'changedTouches', { value: changedTouches });
  Object.defineProperty(event, 'touches', { value: activeTouchList });
  return event;
}
