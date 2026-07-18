import { describe, it, expect, afterEach } from 'vitest';
import '../../src/ui/icon-button';

describe('ce-icon-button', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders with icon name', () => {
    const el = document.createElement('ce-icon-button');
    el.setAttribute('icon', 'close');
    document.body.appendChild(el);

    const btn = el.shadowRoot!.querySelector('button')!;
    expect(btn.textContent).toContain('\u00d7');
  });

  it('renders plus icon', () => {
    const el = document.createElement('ce-icon-button');
    el.setAttribute('icon', 'plus');
    document.body.appendChild(el);

    expect(el.shadowRoot!.querySelector('button')!.textContent).toContain('+');
  });

  it('renders disabled', () => {
    const el = document.createElement('ce-icon-button');
    el.setAttribute('disabled', '');
    document.body.appendChild(el);

    expect(el.shadowRoot!.querySelector('button')!.disabled).toBe(true);
  });
});
