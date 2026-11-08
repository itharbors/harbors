// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  window.eval(readFileSync(new NodeURL('./panel-ui.js', import.meta.url), 'utf8'));
});

describe('Harness UI styles', () => {
  it('installs once per document or shadow root without affecting other roots', () => {
    const api = (window as any).HarnessUI;
    api.install(document);
    api.install(document);
    expect(document.head.querySelectorAll('style[data-harness-ui]')).toHaveLength(1);
    expect(document.head.querySelector('style[data-harness-ui]')!.textContent).toContain('@media (prefers-reduced-motion: reduce)');
    const first = document.createElement('div').attachShadow({ mode: 'open' });
    const second = document.createElement('div').attachShadow({ mode: 'open' });
    api.install(first);
    api.install(first);
    expect(first.querySelectorAll('style[data-harness-ui]')).toHaveLength(1);
    expect(second.querySelectorAll('style[data-harness-ui]')).toHaveLength(0);
    api.install(second);
    expect(second.querySelectorAll('style[data-harness-ui]')).toHaveLength(1);
  });

  it('retains native form, toggle and disabled behavior', () => {
    const form = document.createElement('form');
    form.innerHTML = `<label class="h-switch"><input type="checkbox" name="enabled"><span class="h-switch__track"></span>启用</label>
      <label><input class="h-radio" type="radio" name="mode" value="a">A</label>
      <label><input class="h-radio" type="radio" name="mode" value="b">B</label>
      <button type="button" class="h-button h-button--primary" disabled>禁用</button>`;
    document.body.append(form);
    const checkbox = form.querySelector<HTMLInputElement>('[name="enabled"]')!;
    form.querySelector<HTMLLabelElement>('.h-switch')!.click();
    expect(checkbox.checked).toBe(true);
    const radios = form.querySelectorAll<HTMLInputElement>('[name="mode"]');
    radios[0].click(); radios[1].click();
    expect(radios[0].checked).toBe(false);
    expect(radios[1].checked).toBe(true);
    expect(new FormData(form).get('mode')).toBe('b');
    const listener = vi.fn();
    const button = form.querySelector('button')!;
    button.addEventListener('click', listener);
    button.click();
    expect(listener).not.toHaveBeenCalled();
    form.remove();
  });
});
