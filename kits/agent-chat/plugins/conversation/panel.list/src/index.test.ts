import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import definition from '../dist/index.js';

test('点击新对话通过 Panel SDK 请求 select(null)，并把草稿广播交给 Chat 订阅方', async () => {
  const dom = new JSDOM('<!doctype html><div id="panel-root"></div>', { url: 'http://localhost/panel' });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
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
  } finally {
    definition.unmount?.();
    Object.assign(globalThis, {
      window: previousWindow,
      document: previousDocument,
      HTMLElement: previousHTMLElement,
    });
  }
});
