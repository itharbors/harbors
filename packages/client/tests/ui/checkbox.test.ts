import { describe, it, expect, afterEach } from 'vitest';
import '../../src/ui/checkbox';
import '../../src/ui/radio';
import '../../src/ui/toggle';

describe('ce-checkbox', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders unchecked by default', () => {
    const el = document.createElement('ce-checkbox');
    document.body.appendChild(el);

    const input = el.shadowRoot!.querySelector('input')!;
    const style = el.shadowRoot!.querySelector('style')!.textContent!;
    expect(input.checked).toBe(false);
    expect(style).toContain('--ce-checkbox-bg');
    expect(style).toContain('--ce-checkbox-border');
    expect(style).toContain('--ce-checkbox-bg-checked');
    expect(style).toContain('--ce-checkbox-border-checked');
    expect(style).toContain('--ce-checkbox-check');
    expect(style).toContain('--ce-checkbox-focus-ring');
    expect(style).toContain('--ce-checkbox-disabled-opacity');
    expect(style).not.toContain('accent-color');
  });

  it('renders checked when attribute set', () => {
    const el = document.createElement('ce-checkbox');
    el.setAttribute('checked', '');
    document.body.appendChild(el);

    expect(el.shadowRoot!.querySelector('input')!.checked).toBe(true);
  });

  it('dispatches ce-change on toggle', () => {
    const el = document.createElement('ce-checkbox');
    document.body.appendChild(el);

    const detailPromise = new Promise<boolean>((resolve) => {
      el.addEventListener('ce-change', ((e: CustomEvent) => resolve(e.detail.checked)) as EventListener);
    });

    el.shadowRoot!.querySelector('input')!.click();

    return detailPromise.then((checked) => {
      expect(checked).toBe(true);
      expect(el.hasAttribute('checked')).toBe(true);
    });
  });

  it('renders label text', () => {
    const el = document.createElement('ce-checkbox');
    el.setAttribute('label', 'Accept terms');
    document.body.appendChild(el);

    const label = el.shadowRoot!.querySelector('label')!;
    expect(label.textContent).toContain('Accept terms');
  });
});

describe('ce-radio', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders radio input', () => {
    const el = document.createElement('ce-radio');
    document.body.appendChild(el);

    expect(el.shadowRoot!.querySelector('input')!.type).toBe('radio');
  });

  it('same name group is mutually exclusive', () => {
    const r1 = document.createElement('ce-radio');
    r1.setAttribute('name', 'group1');
    const r2 = document.createElement('ce-radio');
    r2.setAttribute('name', 'group1');
    document.body.appendChild(r1);
    document.body.appendChild(r2);

    r1.shadowRoot!.querySelector('input')!.click();
    expect(r1.hasAttribute('checked')).toBe(true);

    r2.shadowRoot!.querySelector('input')!.click();
    expect(r1.hasAttribute('checked')).toBe(false);
    expect(r2.hasAttribute('checked')).toBe(true);
  });
});

describe('ce-toggle', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders off by default', () => {
    const el = document.createElement('ce-toggle');
    document.body.appendChild(el);

    const input = el.shadowRoot!.querySelector('input')!;
    expect(input.checked).toBe(false);
  });

  it('toggles on click', () => {
    const el = document.createElement('ce-toggle');
    document.body.appendChild(el);

    const detailPromise = new Promise<boolean>((resolve) => {
      el.addEventListener('ce-change', ((e: CustomEvent) => resolve(e.detail.checked)) as EventListener);
    });

    el.shadowRoot!.querySelector('input')!.click();

    return detailPromise.then((checked) => {
      expect(checked).toBe(true);
      expect(el.hasAttribute('checked')).toBe(true);
    });
  });
});
