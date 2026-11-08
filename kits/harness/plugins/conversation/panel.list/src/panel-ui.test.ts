import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const entry = readFileSync(new URL('../../../../ui/panel-ui.js', import.meta.url), 'utf8');

test('Kit 按钮保留原生按钮语义和禁用状态', () => {
  const dom = new JSDOM('<!doctype html><form><harness-button aria-label="新建对话">新建</harness-button></form>', { runScripts: 'outside-only' });
  try {
    dom.window.eval(entry);
    const host = dom.window.document.querySelector('harness-button')!;
    const button = host.shadowRoot!.querySelector('button')!;
    assert.equal(button.type, 'button');
    assert.equal(button.getAttribute('aria-label'), '新建对话');
    let clicks = 0;
    let submissions = 0;
    host.addEventListener('click', () => { clicks += 1; });
    dom.window.document.querySelector('form')!.addEventListener('submit', () => { submissions += 1; });
    button.click();
    assert.equal(clicks, 1);
    assert.equal(submissions, 0);
    host.setAttribute('disabled', '');
    assert.equal(button.disabled, true);
    button.click();
    assert.equal(clicks, 1);
    (host as HTMLElement).click();
    assert.equal(clicks, 1);
    host.removeAttribute('disabled');
    assert.equal(button.disabled, false);
    button.focus();
    assert.equal(dom.window.document.activeElement, host);
    assert.equal(host.shadowRoot!.activeElement, button);
  } finally { dom.window.close(); }
});
