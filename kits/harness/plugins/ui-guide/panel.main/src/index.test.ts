import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import guide from './index.ts';

test('explains how to open the shared controls when Kit UI is unavailable', () => {
  const dom = new JSDOM('<div id="panel-root"></div>');
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  try {
    guide.mount();
    assert.match(dom.window.document.body.textContent ?? '', /视图 → 面板 → 界面规范/);
    assert.equal(dom.window.document.querySelector('.h-button'), null);
  } finally {
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});

test('installs shared styles and exposes interactive native controls', () => {
  const dom = new JSDOM('<div id="panel-root"></div>');
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  let installed: Document | ShadowRoot | undefined;
  Object.assign(dom.window, { HarnessUI: { install(root: Document | ShadowRoot) { installed = root; } } });
  try {
    guide.mount();
    assert.equal(installed, dom.window.document);
    const document = dom.window.document;
    const text = document.querySelector<HTMLInputElement>('.h-input:not(:disabled)')!;
    text.value = '测试';
    assert.equal(text.value, '测试');
    const checks = document.querySelectorAll<HTMLInputElement>('.h-check:not(:disabled)');
    checks[1]!.click();
    assert.equal(checks[1]!.checked, true);
    const radios = document.querySelectorAll<HTMLInputElement>('.h-radio');
    radios[1]!.click();
    assert.equal(radios[1]!.checked, true);
    assert.equal(radios[0]!.checked, false);
    const toggle = document.querySelector<HTMLInputElement>('.h-switch input')!;
    toggle.click();
    assert.equal(toggle.checked, true);
    document.querySelector<HTMLButtonElement>('#feedback-button')!.click();
    assert.equal(document.querySelector('#feedback-result')!.textContent, '操作已完成。');
    const items = document.querySelectorAll<HTMLButtonElement>('.list-examples .h-list-item');
    items[1]!.click();
    assert.equal(items[0]!.getAttribute('aria-pressed'), 'false');
    assert.equal(items[1]!.getAttribute('aria-pressed'), 'true');
    assert.equal(items[2]!.disabled, true);
    assert.equal(document.querySelectorAll('.h-table tbody tr').length, 2);
  } finally {
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});
