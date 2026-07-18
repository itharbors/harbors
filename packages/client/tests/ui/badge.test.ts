import { describe, expect, it } from 'vitest';
import '../../src/ui/badge';
import '../../src/ui/icon';
import '../../src/ui/progress';

describe('ce-badge', () => {
  it('renders projected text content through its slot', () => {
    const el = document.createElement('ce-badge');
    el.textContent = 'NEW';
    document.body.appendChild(el);

    const slot = el.shadowRoot!.querySelector('slot') as HTMLSlotElement;

    expect(slot.assignedNodes().map((node) => node.textContent).join('')).toBe('NEW');

    document.body.removeChild(el);
  });

  it('renders info variant by default', () => {
    const el = document.createElement('ce-badge');
    document.body.appendChild(el);

    expect(el.shadowRoot!.querySelector('span')!.className).toContain('info');

    document.body.removeChild(el);
  });

  it('renders success variant', () => {
    const el = document.createElement('ce-badge');
    el.setAttribute('variant', 'success');
    document.body.appendChild(el);

    expect(el.shadowRoot!.querySelector('span')!.className).toContain('success');

    document.body.removeChild(el);
  });
});

describe('ce-progress', () => {
  it('renders progress bar at given value', () => {
    const el = document.createElement('ce-progress');
    el.setAttribute('value', '60');
    document.body.appendChild(el);

    const bar = el.shadowRoot!.querySelector('.fill') as HTMLElement;

    expect(bar.style.width).toBe('60%');

    document.body.removeChild(el);
  });

  it('renders indeterminate animation class', () => {
    const el = document.createElement('ce-progress');
    el.setAttribute('indeterminate', '');
    document.body.appendChild(el);

    const bar = el.shadowRoot!.querySelector('.fill') as HTMLElement;

    expect(bar.className).toContain('indeterminate');

    document.body.removeChild(el);
  });

  it('clamps value to 0-100', () => {
    const el = document.createElement('ce-progress');
    el.setAttribute('value', '150');
    document.body.appendChild(el);

    expect((el.shadowRoot!.querySelector('.fill') as HTMLElement).style.width).toBe('100%');

    document.body.removeChild(el);
  });
});

describe('ce-icon', () => {
  it('renders icon character by name', () => {
    const el = document.createElement('ce-icon');
    el.setAttribute('name', 'close');
    document.body.appendChild(el);

    expect(el.shadowRoot!.textContent).toContain('\u00d7');

    document.body.removeChild(el);
  });

  it('renders different sizes', () => {
    const el = document.createElement('ce-icon');
    el.setAttribute('name', 'plus');
    el.setAttribute('size', 'lg');
    document.body.appendChild(el);

    expect(el.shadowRoot!.querySelector('span')!.className).toContain('lg');

    document.body.removeChild(el);
  });
});
