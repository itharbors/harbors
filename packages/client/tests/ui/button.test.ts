import { describe, it, expect, afterEach } from 'vitest';
import '../../src/ui/button';

function renderButton(attributes: Record<string, string | boolean> = {}, textContent = '') {
  const el = document.createElement('ce-button');
  for (const [name, value] of Object.entries(attributes)) {
    if (value === true) {
      el.setAttribute(name, '');
      continue;
    }
    el.setAttribute(name, String(value));
  }
  el.textContent = textContent;
  document.body.appendChild(el);
  return el;
}

function getButton(el: HTMLElement) {
  return el.shadowRoot!.querySelector('button')!;
}

function getStylesheet(el: HTMLElement) {
  return el.shadowRoot!.querySelector('style')!.textContent!;
}

describe('ce-button', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders with default variant secondary', () => {
    const el = renderButton({}, 'Click');

    const btn = getButton(el);
    expect(btn.textContent).toContain('Click');
    expect(btn.className).toContain('secondary');
  });

  it('renders primary variant', () => {
    const el = renderButton({ variant: 'primary' });

    const btn = getButton(el);
    expect(btn.className).toContain('primary');
  });

  it('renders disabled state', () => {
    const el = renderButton({ disabled: true });

    const btn = getButton(el);
    expect(btn.disabled).toBe(true);
  });

  it('renders sm size', () => {
    const el = renderButton({ size: 'sm' });

    const btn = getButton(el);
    expect(btn.className).toContain('sm');
  });

  it('falls back to supported variant and size values', () => {
    const el = renderButton({ variant: 'primary other', size: 'lg' });

    const btn = getButton(el);
    expect(btn.className).toBe('secondary md');
  });

  it('re-renders when variant changes', () => {
    const el = renderButton({ variant: 'secondary' });
    el.setAttribute('variant', 'danger');

    const btn = getButton(el);
    expect(btn.className).toContain('danger');
  });

  it('uses shared button tokens in the stylesheet', () => {
    const el = renderButton();
    const stylesheet = getStylesheet(el);

    expect(stylesheet).toContain('border: 1px solid var(--ce-button-border, var(--ce-border, #444));');
    expect(stylesheet).toContain('color: var(--ce-button-fg, var(--ce-text-primary, #fff));');
    expect(stylesheet).toContain('background: var(--ce-button-bg, var(--ce-surface-raised, #2d2d2d));');
    expect(stylesheet).toContain('background: var(--ce-button-bg-hover, var(--ce-surface-hover, #353b45));');
    expect(stylesheet).toContain('background: var(--ce-button-bg-active, var(--ce-surface-active, #232934));');
    expect(stylesheet).toContain('outline: 2px solid var(--ce-button-focus-ring, var(--ce-focus-ring, var(--ce-accent, #569cd6)));');
    expect(stylesheet).toContain('outline-offset: 2px;');
    expect(stylesheet).toContain('color: var(--ce-button-disabled-fg, var(--ce-text-muted, #666d79));');
    expect(stylesheet).toContain('background: var(--ce-button-disabled-bg, #15181d);');
    expect(stylesheet).toContain('border-color: var(--ce-button-disabled-border, #2b313c);');
  });
});
