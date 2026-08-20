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

test('mount bridges getSettings, saveSettings, and resetSettings through postMessage', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://host.test/agent-settings', runScripts: 'outside-only' });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const sent: Array<{ type: string; requestId: string; name: string; args: unknown[] }> = [];
  const parent = dom.window.parent;
  const originalPostMessage = parent.postMessage;
  parent.postMessage = ((message: typeof sent[number]) => { sent.push(message); }) as typeof parent.postMessage;
  // Embedded Web panels can expose a Window without DOM constructors. The panel
  // must still bind controls using realm-independent node checks.
  for (const constructorName of ['HTMLFormElement', 'HTMLSelectElement', 'HTMLButtonElement']) {
    Object.defineProperty(dom.window, constructorName, { configurable: true, value: undefined });
  }
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });

  const respond = async (result: unknown, error?: string) => {
    await nextTurn();
    const request = sent.at(-1);
    assert.ok(request);
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'settings-page-response', requestId: request.requestId, ...(error ? { error } : { result }) },
      source: dom.window,
    }));
    await nextTurn();
  };

  try {
    definition.mount();
    await respond({ sandboxMode: 'danger-full-access', approvalPolicy: 'always', global: { sandboxMode: true, approvalPolicy: true } });
    assert.equal(sent[0]?.type, 'settings-page-request');
    assert.equal(sent[0]?.name, 'getSettings');
    assert.equal((dom.window.document.getElementById('sandbox-mode') as HTMLSelectElement).value, 'danger-full-access');
    assert.equal((dom.window.document.getElementById('approval-policy') as HTMLSelectElement).value, 'always');

    const sandbox = dom.window.document.getElementById('sandbox-mode') as HTMLSelectElement;
    const approval = dom.window.document.getElementById('approval-policy') as HTMLSelectElement;
    sandbox.value = 'read-only';
    approval.value = 'ask';
    (dom.window.document.getElementById('save-button') as HTMLButtonElement).click();
    await respond({ sandboxMode: 'read-only', approvalPolicy: 'ask', global: { sandboxMode: true, approvalPolicy: true } });
    assert.equal(sent.length, 2, 'a save click must issue exactly one request');
    assert.equal(sent[1]?.name, 'saveSettings');
    assert.deepEqual(sent[1]?.args, [{ sandboxMode: 'read-only', approvalPolicy: 'ask' }]);
    assert.equal(dom.window.document.getElementById('status')?.textContent, '设置已保存，仅影响新对话；当前对话不变。');
    assert.equal((dom.window.document.getElementById('save-button') as HTMLButtonElement).disabled, false);

    (dom.window.document.getElementById('reset-button') as HTMLButtonElement).click();
    await respond({ sandboxMode: 'workspace-write', approvalPolicy: 'ask', global: { sandboxMode: false, approvalPolicy: false } });
    assert.equal(sent[2]?.name, 'resetSettings');
    assert.deepEqual(sent[2]?.args, []);
    assert.equal(dom.window.document.getElementById('status')?.textContent, '已恢复默认设置，仅影响新对话；当前对话不变。');

    (dom.window.document.getElementById('save-button') as HTMLButtonElement).click();
    await respond(undefined, '设置未能持久化');
    assert.equal(dom.window.document.getElementById('status')?.textContent, '设置未能持久化');
    assert.equal((dom.window.document.getElementById('status') as HTMLElement).dataset.kind, 'error');
    assert.equal((dom.window.document.getElementById('save-button') as HTMLButtonElement).disabled, false);

    const pending = requestSettings('getSettings');
    definition.unmount();
    await assert.rejects(pending, /设置页面已卸载/);
  } finally {
    definition.unmount();
    parent.postMessage = originalPostMessage;
    Object.assign(globalThis, { window: previousWindow, document: previousDocument });
  }
});

test('Settings 页面资源包含两个权限选择器和 postMessage 协议', async () => {
  const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('./index.css', import.meta.url), 'utf8');
  assert.match(html, /id="sandbox-mode"/);
  assert.match(html, /id="approval-policy"/);
  assert.match(source, /type: 'settings-page-request'/);
  assert.match(source, /type: 'settings-page-response'/);
  assert.match(source, /window\.parent\.postMessage/);
  assert.match(source, /form\.addEventListener\('submit', onSubmit\)/);
  assert.match(source, /elements\.save\.addEventListener\('click', onSaveClick\)/);
  assert.doesNotMatch(source, /ctx\.message/);
  assert.match(css, /\.settings-card/);
});
