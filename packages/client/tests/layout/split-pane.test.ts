import { describe, it, expect, afterEach } from 'vitest';
import '../../src/layout/split-pane';

describe('ce-split-pane', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders with default direction row', () => {
    const el = document.createElement('ce-split-pane');
    document.body.appendChild(el);

    const container = el.shadowRoot!.querySelector('.container')!;
    expect(getComputedStyle(container).flexDirection).toBe('row');
  });

  it('renders column direction when set', () => {
    const el = document.createElement('ce-split-pane');
    el.setAttribute('direction', 'column');
    document.body.appendChild(el);

    const container = el.shadowRoot!.querySelector('.container')!;
    expect(getComputedStyle(container).flexDirection).toBe('column');
  });

  it('reflects direction attribute changes', () => {
    const el = document.createElement('ce-split-pane');
    document.body.appendChild(el);

    el.setAttribute('direction', 'column');

    const container = el.shadowRoot!.querySelector('.container')!;
    expect(getComputedStyle(container).flexDirection).toBe('column');
  });

  it('renders child elements via slot', () => {
    const el = document.createElement('ce-split-pane');
    const child = document.createElement('div');
    child.textContent = 'test';
    el.appendChild(child);
    document.body.appendChild(el);

    expect(el.shadowRoot!.querySelector('slot')).not.toBeNull();
    expect(el.children).toHaveLength(1);
  });
});
