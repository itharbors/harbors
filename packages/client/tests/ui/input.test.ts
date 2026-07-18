import { describe, it, expect, afterEach } from 'vitest';
import '../../src/ui/input';
import '../../src/ui/textarea';

describe('ce-input', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders input element', () => {
    const el = document.createElement('ce-input');
    document.body.appendChild(el);

    const input = el.shadowRoot!.querySelector('input')!;
    const style = el.shadowRoot!.querySelector('style')!.textContent!;
    expect(input).not.toBeNull();
    expect(input.type).toBe('text');
    expect(style).toContain('--ce-input-bg');
    expect(style).toContain('--ce-input-border');
    expect(style).toContain('--ce-input-fg');
    expect(style).toContain('--ce-input-placeholder');
    expect(style).toContain('--ce-input-focus-ring');
    expect(style).toContain('--ce-input-disabled-bg');
    expect(style).toContain('--ce-input-disabled-border');
    expect(style).toContain('--ce-input-disabled-fg');
  });

  it('reflects value attribute', () => {
    const el = document.createElement('ce-input');
    el.setAttribute('value', 'hello');
    document.body.appendChild(el);

    const input = el.shadowRoot!.querySelector('input')!;
    expect(input.value).toBe('hello');
  });

  it('reflects placeholder', () => {
    const el = document.createElement('ce-input');
    el.setAttribute('placeholder', 'type here');
    document.body.appendChild(el);

    const input = el.shadowRoot!.querySelector('input')!;
    expect(input.placeholder).toBe('type here');
  });

  it('dispatches ce-input on user input', () => {
    const el = document.createElement('ce-input');
    document.body.appendChild(el);

    const detailPromise = new Promise<string>((resolve) => {
      el.addEventListener('ce-input', ((e: CustomEvent) => resolve(e.detail.value)) as EventListener);
    });

    const input = el.shadowRoot!.querySelector('input')!;
    input.value = 'abc';
    input.dispatchEvent(new Event('input'));

    return detailPromise.then((value) => {
      expect(value).toBe('abc');
    });
  });

  it('renders disabled state', () => {
    const el = document.createElement('ce-input');
    el.setAttribute('disabled', '');
    document.body.appendChild(el);

    expect(el.shadowRoot!.querySelector('input')!.disabled).toBe(true);
  });

  it('supports password type', () => {
    const el = document.createElement('ce-input');
    el.setAttribute('type', 'password');
    document.body.appendChild(el);

    expect(el.shadowRoot!.querySelector('input')!.type).toBe('password');
  });
});

describe('ce-textarea', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders textarea element', () => {
    const el = document.createElement('ce-textarea');
    document.body.appendChild(el);

    const textarea = el.shadowRoot!.querySelector('textarea')!;
    const style = el.shadowRoot!.querySelector('style')!.textContent!;
    expect(textarea).not.toBeNull();
    expect(style).toContain('--ce-input-bg');
    expect(style).toContain('--ce-input-border');
    expect(style).toContain('--ce-input-fg');
    expect(style).toContain('--ce-input-placeholder');
    expect(style).toContain('--ce-input-focus-ring');
    expect(style).toContain('--ce-input-disabled-bg');
    expect(style).toContain('--ce-input-disabled-border');
    expect(style).toContain('--ce-input-disabled-fg');
  });

  it('reflects value', () => {
    const el = document.createElement('ce-textarea');
    el.setAttribute('value', 'multiline content');
    document.body.appendChild(el);

    expect(el.shadowRoot!.querySelector('textarea')!.value).toBe('multiline content');
  });

  it('respects rows attribute', () => {
    const el = document.createElement('ce-textarea');
    el.setAttribute('rows', '6');
    document.body.appendChild(el);

    expect(el.shadowRoot!.querySelector('textarea')!.rows).toBe(6);
  });
});
