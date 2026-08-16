import { describe, it, expect, afterEach } from 'vitest';
import '../../src/layout/tabs';

describe('ce-tabs', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders tab bar and content area', () => {
    const el = document.createElement('ce-tabs');
    document.body.appendChild(el);

    expect(el.shadowRoot!.querySelector('.tab-bar')).not.toBeNull();
    expect(el.shadowRoot!.querySelector('.tab-content')).not.toBeNull();
  });

  it('dispatches ce-tab-change when tab is clicked', async () => {
    const el = document.createElement('ce-tabs');
    const tab1 = document.createElement('ce-tab');
    tab1.setAttribute('label', 'One');
    const tab2 = document.createElement('ce-tab');
    tab2.setAttribute('label', 'Two');
    el.append(tab1, tab2);
    document.body.appendChild(el);

    const detailPromise = new Promise<{ label: string; index: number }>((resolve) => {
      el.addEventListener('ce-tab-change', ((event: CustomEvent<{ label: string; index: number }>) => {
        resolve(event.detail);
      }) as EventListener);
    });

    (el.shadowRoot!.querySelectorAll('.tab-label')[1] as HTMLElement).click();

    await expect(detailPromise).resolves.toEqual({ label: 'Two', index: 1 });
    expect(tab2.hasAttribute('active')).toBe(true);
    expect(tab1.hasAttribute('active')).toBe(false);
  });

  it('switches tabs on a touch pointer release', () => {
    const el = document.createElement('ce-tabs');
    const first = document.createElement('ce-tab');
    first.setAttribute('label', 'One');
    const second = document.createElement('ce-tab');
    second.setAttribute('label', 'Two');
    el.append(first, second);
    document.body.appendChild(el);

    const tab = el.shadowRoot!.querySelectorAll('.tab-item')[1] as HTMLElement;
    const event = new Event('pointerup', { bubbles: true, composed: true }) as PointerEvent;
    Object.defineProperty(event, 'pointerType', { value: 'touch' });
    tab.dispatchEvent(event);

    expect(second.hasAttribute('active')).toBe(true);
  });

  it('switches tabs across a touchstart and touchend gesture', () => {
    const el = document.createElement('ce-tabs');
    const first = document.createElement('ce-tab');
    first.setAttribute('label', 'One');
    const second = document.createElement('ce-tab');
    second.setAttribute('label', 'Two');
    el.append(first, second);
    document.body.appendChild(el);

    const tab = el.shadowRoot!.querySelectorAll('.tab-item')[1] as HTMLElement;
    tab.dispatchEvent(new Event('touchstart', { bubbles: true, composed: true }));
    tab.dispatchEvent(new Event('touchend', { bubbles: true, composed: true }));

    expect(second.hasAttribute('active')).toBe(true);
  });

  it('dispatches ce-tab-close when close button clicked', async () => {
    const el = document.createElement('ce-tabs');
    const tab1 = document.createElement('ce-tab');
    tab1.setAttribute('label', 'CloseMe');
    el.appendChild(tab1);
    document.body.appendChild(el);

    const detailPromise = new Promise<{ label: string; index: number }>((resolve) => {
      el.addEventListener('ce-tab-close', ((event: CustomEvent<{ label: string; index: number }>) => {
        resolve(event.detail);
      }) as EventListener);
    });

    (el.shadowRoot!.querySelector('.tab-close') as HTMLElement).click();

    await expect(detailPromise).resolves.toEqual({ label: 'CloseMe', index: 0 });
  });

  it('updates rendered labels when tab attributes change', async () => {
    const el = document.createElement('ce-tabs');
    const tab = document.createElement('ce-tab');
    tab.setAttribute('label', 'Before');
    el.appendChild(tab);
    document.body.appendChild(el);

    tab.setAttribute('label', 'After');
    await Promise.resolve();

    expect(el.shadowRoot!.textContent).toContain('After');
  });

  it('uses shared tab token fallbacks in styles', () => {
    const el = document.createElement('ce-tabs');
    const tab = document.createElement('ce-tab');
    tab.setAttribute('label', 'One');
    tab.setAttribute('active', '');
    el.appendChild(tab);
    document.body.appendChild(el);

    const styles = el.shadowRoot!.querySelector('style')!.textContent || '';
    expect(styles).toContain('var(--ce-tabbar-bg, var(--ce-surface-raised, #2d2d2d))');
    expect(styles).toContain('var(--ce-tab-bg-active, var(--ce-surface, #1a1a1a))');
    expect(styles).toContain('var(--ce-tab-active-indicator, var(--ce-accent, #569cd6))');
  });
});

describe('ce-tab', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('reflects active attribute', () => {
    const el = document.createElement('ce-tab');
    document.body.appendChild(el);

    el.setAttribute('active', '');
    expect(el.hasAttribute('active')).toBe(true);

    el.removeAttribute('active');
    expect(el.hasAttribute('active')).toBe(false);
  });

  it('exposes label property', () => {
    const el = document.createElement('ce-tab') as HTMLElement & { label: string };
    el.setAttribute('label', 'test.ts');
    document.body.appendChild(el);

    expect(el.label).toBe('test.ts');
  });
});
