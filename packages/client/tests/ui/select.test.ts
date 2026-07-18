import { describe, it, expect, afterEach } from 'vitest';
import '../../src/ui/select';

describe('ce-select', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders native select with options', () => {
    const el = document.createElement('ce-select');
    const opt1 = document.createElement('ce-option');
    opt1.setAttribute('value', 'a');
    opt1.textContent = 'Option A';
    const opt2 = document.createElement('ce-option');
    opt2.setAttribute('value', 'b');
    opt2.textContent = 'Option B';
    el.appendChild(opt1);
    el.appendChild(opt2);
    document.body.appendChild(el);

    const select = el.shadowRoot!.querySelector('select')!;
    const style = el.shadowRoot!.querySelector('style')!.textContent!;
    expect(select).not.toBeNull();
    expect(select.options.length).toBe(2);
    expect(select.options[0].value).toBe('a');
    expect(style).toContain('--ce-input-bg');
    expect(style).toContain('--ce-input-border');
    expect(style).toContain('--ce-input-fg');
    expect(style).toContain('--ce-input-focus-ring');
    expect(style).toContain('--ce-input-disabled-bg');
    expect(style).toContain('--ce-input-disabled-border');
    expect(style).toContain('--ce-input-disabled-fg');
  });

  it('preselects option with selected attribute', () => {
    const el = document.createElement('ce-select');
    const opt1 = document.createElement('ce-option');
    opt1.setAttribute('value', 'a');
    const opt2 = document.createElement('ce-option');
    opt2.setAttribute('value', 'b');
    opt2.setAttribute('selected', '');
    el.appendChild(opt1);
    el.appendChild(opt2);
    document.body.appendChild(el);

    expect(el.shadowRoot!.querySelector('select')!.value).toBe('b');
  });

  it('dispatches ce-change on selection', () => {
    const el = document.createElement('ce-select');
    const opt1 = document.createElement('ce-option');
    opt1.setAttribute('value', 'x');
    el.appendChild(opt1);
    document.body.appendChild(el);

    const detailPromise = new Promise<string>((resolve) => {
      el.addEventListener('ce-change', ((e: CustomEvent) => resolve(e.detail.value)) as EventListener);
    });

    const select = el.shadowRoot!.querySelector('select')!;
    select.value = 'x';
    select.dispatchEvent(new Event('change'));

    return detailPromise.then((value) => {
      expect(value).toBe('x');
      expect(el.getAttribute('value')).toBe('x');
    });
  });
});
