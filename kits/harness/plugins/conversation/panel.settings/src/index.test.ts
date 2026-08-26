import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import definition from './index.ts';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test('设置页直接请求 Conversation owner，渲染归档并恢复', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://host.test/conversation-settings' });
  const previousWindow = globalThis.window; const previousDocument = globalThis.document;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  const calls: unknown[][] = [];
  try {
    definition.mount({ message: { request: async (owner: string, name: string, ...args: unknown[]) => {
      calls.push([owner, name, ...args]); assert.equal(owner, 'conversation');
      if (name === 'listArchivedConversations') return { ok: true, value: [{ id: 'harbors:a', source: 'harbors', title: 'A', project: '/workspace', updatedAt: new Date(0).toISOString(), archivedAt: new Date(1).toISOString(), status: 'available' }] };
      return { ok: true, value: { id: 'harbors:a' } };
    } } });
    await tick();
    assert.equal(calls[0]?.[1], 'listArchivedConversations');
    const button = dom.window.document.querySelector('.archive-card button') as HTMLButtonElement;
    assert.match(button.getAttribute('aria-label') || '', /恢复对话/); button.click(); await tick(); await tick();
    assert.ok(calls.some((call) => call[1] === 'restoreConversation' && call[2] === 'harbors:a'));
    assert.match(dom.window.document.getElementById('status')?.textContent || '', /对话已恢复/);
  } finally { definition.unmount(); Object.assign(globalThis, { window: previousWindow, document: previousDocument }); }
});

test('读取失败显示可操作重试按钮，重试成功后隐藏按钮并渲染列表', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://host.test/conversation-settings' });
  const previousWindow = globalThis.window; const previousDocument = globalThis.document;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  let calls = 0;
  try {
    definition.mount({ message: { request: async () => ++calls === 1
      ? { ok: false, error: { code: 'ARCHIVE_OPERATION_FAILED', message: '读取失败' } }
      : { ok: true, value: [{ id: 'harbors:a', source: 'harbors', title: 'A', archivedAt: new Date(1).toISOString(), status: 'available' }] } } });
    await tick();
    const retry = dom.window.document.getElementById('retry') as HTMLButtonElement;
    assert.equal(retry.hidden, false);
    assert.equal(retry.textContent, '重试读取');
    retry.click(); await tick();
    assert.equal(retry.hidden, true);
    assert.match(dom.window.document.getElementById('status')?.textContent || '', /共 1 条归档/);
    assert.equal(dom.window.document.querySelectorAll('.archive-card').length, 1);
  } finally { definition.unmount(); Object.assign(globalThis, { window: previousWindow, document: previousDocument }); }
});

test('设置页业务失败读取 envelope，transport 异常使用不可用提示', async () => {
  const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  const css = await readFile(new URL('./index.css', import.meta.url), 'utf8');
  assert.match(source, /result\.ok === false/); assert.match(source, /归档服务暂不可用/);
  assert.doesNotMatch(source, /request\('agent'/); assert.match(css, /focus-visible/); assert.match(css, /max-width: 360px/);
});

test('永久删除必须确认，确认后请求 Conversation 并刷新列表', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://host.test/conversation-settings' });
  const previousWindow = globalThis.window; const previousDocument = globalThis.document;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  let archived = true;
  const calls: unknown[][] = [];
  try {
    definition.mount({ message: { request: async (owner: string, name: string, ...args: unknown[]) => {
      calls.push([owner, name, ...args]);
      if (name === 'listArchivedConversations') return { ok: true, value: archived ? [{ id: 'harbors:a', source: 'harbors', title: 'A', archivedAt: new Date(1).toISOString(), status: 'available' }] : [] };
      if (name === 'deleteArchivedConversation') { archived = false; return { ok: true, value: { id: args[0] } }; }
      throw new Error(`unexpected ${name}`);
    } } });
    await tick();
    const deleteButton = [...dom.window.document.querySelectorAll<HTMLButtonElement>('.archive-card button')].find((button) => button.textContent === '删除')!;
    dom.window.confirm = () => false;
    deleteButton.click(); await tick();
    assert.equal(calls.some((call) => call[1] === 'deleteArchivedConversation'), false);
    dom.window.confirm = () => true;
    deleteButton.click(); await tick(); await tick();
    assert.ok(calls.some((call) => call[1] === 'deleteArchivedConversation' && call[2] === 'harbors:a'));
    assert.equal(dom.window.document.querySelectorAll('.archive-card').length, 0);
    assert.match(dom.window.document.getElementById('status')?.textContent || '', /归档对话已删除/);
  } finally { definition.unmount(); Object.assign(globalThis, { window: previousWindow, document: previousDocument }); }
});
