import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import definition, { requestSettings } from './index.ts';

const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test('exports a standard PanelDefinition without mounting during import', () => {
  assert.equal(typeof definition.mount, 'function');
  assert.equal(typeof definition.unmount, 'function');
});

test('mount requests Agent methods directly through the panel context', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://host.test/agent-settings', runScripts: 'outside-only' });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const calls: unknown[][] = [];
  let failNext = false;
  // Embedded Web panels can expose a Window without DOM constructors. The panel
  // must still bind controls using realm-independent node checks.
  for (const constructorName of ['HTMLFormElement', 'HTMLSelectElement', 'HTMLButtonElement']) {
    Object.defineProperty(dom.window, constructorName, { configurable: true, value: undefined });
  }
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });

  try {
    const request = async (plugin: string, name: string, ...args: unknown[]) => {
      calls.push([plugin, name, ...args]);
      if (failNext) { failNext = false; throw new Error('设置未能持久化'); }
      if (name === 'getSettings') return { sandboxMode: 'danger-full-access', approvalPolicy: 'always', global: { sandboxMode: true, approvalPolicy: true } };
      if (name === 'saveSettings') return { sandboxMode: 'read-only', approvalPolicy: 'ask', global: { sandboxMode: true, approvalPolicy: true } };
      return { sandboxMode: 'workspace-write', approvalPolicy: 'ask', global: { sandboxMode: false, approvalPolicy: false } };
    };
    definition.mount({ message: { request } });
    await nextTurn();
    assert.deepEqual(calls[0], ['agent', 'getSettings']);
    assert.equal((dom.window.document.getElementById('sandbox-mode') as HTMLSelectElement).value, 'danger-full-access');
    assert.equal((dom.window.document.getElementById('approval-policy') as HTMLSelectElement).value, 'always');

    const sandbox = dom.window.document.getElementById('sandbox-mode') as HTMLSelectElement;
    const approval = dom.window.document.getElementById('approval-policy') as HTMLSelectElement;
    sandbox.value = 'read-only';
    approval.value = 'ask';
    (dom.window.document.getElementById('save-button') as HTMLButtonElement).click();
    await nextTurn();
    assert.deepEqual(calls[1], ['agent', 'saveSettings', { sandboxMode: 'read-only', approvalPolicy: 'ask' }]);
    assert.equal(dom.window.document.getElementById('status')?.textContent, '设置已保存，仅影响新对话；当前对话不变。');
    assert.equal((dom.window.document.getElementById('save-button') as HTMLButtonElement).disabled, false);

    (dom.window.document.getElementById('reset-button') as HTMLButtonElement).click();
    await nextTurn();
    assert.deepEqual(calls[2], ['agent', 'resetSettings']);
    assert.equal(dom.window.document.getElementById('status')?.textContent, '已恢复默认设置，仅影响新对话；当前对话不变。');

    failNext = true;
    (dom.window.document.getElementById('save-button') as HTMLButtonElement).click();
    await nextTurn();
    assert.equal(dom.window.document.getElementById('status')?.textContent, '设置未能持久化');
    assert.equal((dom.window.document.getElementById('status') as HTMLElement).dataset.kind, 'error');
    assert.equal((dom.window.document.getElementById('save-button') as HTMLButtonElement).disabled, false);

    const pending = requestSettings('getSettings');
    definition.unmount();
    await assert.rejects(pending, /设置页面已卸载/);
  } finally {
    definition.unmount();
    Object.assign(globalThis, { window: previousWindow, document: previousDocument });
  }
});

test('Settings 页面资源包含两个权限选择器和直接请求协议', async () => {
  const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('./index.css', import.meta.url), 'utf8');
  assert.match(html, /id="sandbox-mode"/);
  assert.match(html, /id="approval-policy"/);
  assert.match(source, /activeRequest\?\.\('agent', name/);
  assert.doesNotMatch(source, /postMessage/);
  assert.match(source, /form\.addEventListener\('submit', onSubmit\)/);
  assert.match(source, /elements\.save\.addEventListener\('click', onSaveClick\)/);
  assert.match(source, /ctx\.message\.request/);
  assert.match(css, /\.settings-card/);
});
