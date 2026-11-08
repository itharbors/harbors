import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { kitUiClass } from './kit-ui.js';

test('uses Kit classes only when shared styles are installed', () => {
  const dom = new JSDOM('<!doctype html>');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  try {
    assert.equal(kitUiClass('h-button h-button--primary'), '');
    const style = dom.window.document.createElement('style');
    style.setAttribute('data-harness-ui', '');
    dom.window.document.head.append(style);
    assert.equal(kitUiClass('h-button h-button--primary'), 'h-button h-button--primary');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
    dom.window.close();
  }
});

test('theme overrides require installed Kit styles and all theme variables have fallbacks', () => {
  for (const file of ['styles.css', 'index.css']) {
    const css = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(css, /:where\(html:has\(> head > style\[data-harness-ui\]\)\)/);
    assert.doesNotMatch(css, /var\(--ce-[\w-]+\)/);
  }
});
