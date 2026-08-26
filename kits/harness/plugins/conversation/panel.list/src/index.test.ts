import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import definition from '../dist/index.js';

test('点击新对话通过 Panel SDK 请求 select(null)，并把草稿广播交给 Chat 订阅方', async () => {
  const dom = new JSDOM('<!doctype html><div id="panel-root"></div>', { url: 'http://localhost/panel' });
  const globalKeys = ['window', 'document', 'HTMLElement'] as const;
  const previousGlobals = new Map(globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
  });

  const requests: Array<[string, string, unknown[]]> = [];
  const chatStates: unknown[] = [];
  const draftState = {
    selectedConversationId: null,
    draft: { source: 'harbors', project: '/workspace/draft' },
    running: false,
    generation: 'conversation-test',
    revision: 1,
  };
  const context = {
    message: {
      broadcast(topic: string, value: unknown): void {
        assert.equal(topic, 'conversation.selected');
        chatStates.push(value);
      },
      async request(plugin: string, name: string, ...args: unknown[]): Promise<unknown> {
        requests.push([plugin, name, args]);
        if (plugin === 'agent' && name === 'listConversations') return [];
        if (plugin === 'conversation' && name === 'getState') return {
          selectedConversationId: null,
          draft: null,
          running: false,
          generation: 'conversation-test',
          revision: 0,
        };
        if (plugin === 'conversation' && name === 'select' && args.length === 1 && args[0] === null) {
          // Conversation main 的 Panel broadcast 会到达 Chat main 的订阅方法。
          context.message.broadcast('conversation.selected', draftState);
          return draftState;
        }
        throw new Error(`unexpected request: ${plugin}.${name}`);
      },
    },
  };

  try {
    await definition.mount(context);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const button = dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="新建对话"]');
    assert.ok(button, '新建对话按钮应在 Panel 中渲染');

    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(requests.some(([plugin, name, args]) => (
      plugin === 'conversation' && name === 'select' && args.length === 1 && args[0] === null
    )));
    assert.deepEqual(chatStates, [draftState]);

    definition.unmount();
    definition.unmount();
    assert.equal(dom.window.document.getElementById('panel-root')?.childElementCount, 0);
    definition.methods.onConversationChanged([{ id: 'late' }]);
    assert.equal(dom.window.document.getElementById('panel-root')?.childElementCount, 0);

    await definition.mount(context);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(dom.window.document.querySelector('button[aria-label="新建对话"]'), '卸载后应可重新挂载');
  } finally {
    definition.unmount();
    dom.window.close();
    for (const key of globalKeys) {
      const descriptor = previousGlobals.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});

test('archive/restore broadcast 幂等收敛，archive 成功 response 无 broadcast 也移除条目', async () => {
  const dom = new JSDOM('<!doctype html><div id="panel-root"></div>', { url: 'http://localhost/panel' });
  const globalKeys = ['window', 'document', 'HTMLElement'] as const;
  const previousGlobals = new Map(globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement });
  const initial = [
    { id: 'harbors:a', title: 'A', source: 'harbors', project: '/workspace', updatedAt: '2026-08-25T00:00:00.000Z' },
    { id: 'harbors:b', title: 'B', source: 'harbors', project: '/workspace', updatedAt: '2026-08-24T00:00:00.000Z' },
  ];
  const context = { message: { async request(plugin: string, name: string, ...args: unknown[]) {
    if (plugin === 'agent' && name === 'listConversations') return initial;
    if (plugin === 'conversation' && name === 'getState') return { selectedConversationId: 'harbors:a', draft: null, running: false, generation: 'list-projection', revision: 1 };
    if (plugin === 'conversation' && name === 'archiveConversation') return { ok: true, value: { id: args[0] } };
    throw new Error(`unexpected request: ${plugin}.${name}`);
  } } };
  const titles = () => Array.from(dom.window.document.querySelectorAll('.conversation-card-title')).map((node) => node.textContent);
  try {
    await definition.mount(context);
    for (let attempt = 0; attempt < 20 && titles().length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(titles(), ['A', 'B']);

    definition.methods.onConversationChanged({ action: 'archive', id: 'harbors:a' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(titles(), ['B']);
    const restored = { id: 'harbors:a', title: 'A restored', source: 'harbors', project: '/workspace', updatedAt: '2026-08-26T00:00:00.000Z' };
    definition.methods.onConversationChanged({ action: 'restore', id: 'harbors:a', conversation: restored });
    definition.methods.onConversationChanged({ action: 'restore', id: 'harbors:a', conversation: restored });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(titles(), ['A restored', 'B']);

    const bCard = Array.from(dom.window.document.querySelectorAll<HTMLElement>('.conversation-card')).find((card) => card.textContent?.includes('B'))!;
    const archiveButton = Array.from(bCard.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === '归档')!;
    archiveButton.click(); await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(titles(), ['A restored']);
  } finally {
    definition.unmount(); dom.window.close();
    for (const key of globalKeys) {
      const descriptor = previousGlobals.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});

test('损坏会话显示不可用提示且鼠标键盘和菜单均不可操作', async () => {
  const dom = new JSDOM('<!doctype html><div id="panel-root"></div>', { url: 'http://localhost/panel' });
  const globalKeys = ['window', 'document', 'HTMLElement'] as const;
  const previousGlobals = new Map(globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement });
  const selectCalls: string[] = [];
  const context = { message: { async request(plugin: string, name: string, ...args: unknown[]) {
    if (plugin === 'agent' && name === 'listConversations') return [
      { id: 'harbors:broken', title: '无法读取的对话', source: 'harbors', availability: 'unavailable', errorCode: 'CONVERSATION_FILE_INVALID' },
      { id: 'harbors:healthy', title: 'Healthy', source: 'harbors', project: '/workspace' },
    ];
    if (plugin === 'conversation' && name === 'getState') return { selectedConversationId: 'harbors:healthy', draft: null, running: false, generation: 'unavailable-projection', revision: 1 };
    if (plugin === 'conversation' && name === 'select') { selectCalls.push(String(args[0])); return {}; }
    throw new Error(`unexpected request: ${plugin}.${name}`);
  } } };
  try {
    await definition.mount(context);
    for (let attempt = 0; attempt < 20 && dom.window.document.querySelectorAll('.conversation-card').length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const broken = Array.from(dom.window.document.querySelectorAll<HTMLElement>('.conversation-card')).find((card) => card.textContent?.includes('无法读取的对话'))!;
    assert.equal(broken.getAttribute('aria-disabled'), 'true');
    assert.equal(broken.tabIndex, -1);
    assert.match(broken.textContent || '', /数据损坏，暂不可用/);
    assert.equal(broken.querySelector('details'), null);
    broken.click();
    broken.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(selectCalls, []);

    const healthy = Array.from(dom.window.document.querySelectorAll<HTMLElement>('.conversation-card')).find((card) => card.textContent?.includes('Healthy'))!;
    healthy.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(selectCalls, ['harbors:healthy']);
  } finally {
    definition.unmount(); dom.window.close();
    for (const key of globalKeys) {
      const descriptor = previousGlobals.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
