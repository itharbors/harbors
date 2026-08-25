import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('mounted panel keeps a cached draft when the initial getState snapshot is stale', async () => {
  const dom = new JSDOM('<!doctype html><div id="panel-root"></div>', { url: 'http://127.0.0.1:49380/panel' });
  dom.window.requestAnimationFrame = (callback: FrameRequestCallback): number => dom.window.setTimeout(() => callback(Date.now()), 0);
  dom.window.cancelAnimationFrame = (handle: number): void => dom.window.clearTimeout(handle);
  const globalKeys = ['window', 'document', 'HTMLElement'] as const;
  const previousGlobals = new Map(globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
  });

  const { default: panel } = await import('../dist/index.js');
  const requests: string[] = [];
  const context = {
    message: {
      async request(_plugin: string, name: string): Promise<unknown> {
        requests.push(name);
        if (name === 'getState') {
          return { selectedConversationId: null, draft: null, generation: 'reloaded-generation', revision: 0 };
        }
        return {};
      },
    },
  };

  try {
    await panel.mount(context);
    // The real bridge can deliver this broadcast while React is still mounting.
    // registerSetter replays it, then getState returns the older empty snapshot.
    panel.methods.onConversationSelected({
      selectedConversationId: null,
      draft: { source: 'harbors', project: '/workspace/draft' },
      generation: 'draft-generation',
      revision: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.ok(requests.includes('getState'));
    assert.ok(document.querySelector('.message-input-container'));
    assert.ok(document.querySelector('textarea'));
    assert.equal(document.querySelector('.empty-state'), null);

    panel.unmount();
    panel.unmount();
    assert.equal(dom.window.document.getElementById('panel-root')?.childElementCount, 0);

    await panel.mount(context);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(document.querySelector('.empty-state'), '重新挂载不应重放旧会话缓存');
    assert.equal(document.querySelector('textarea'), null);
  } finally {
    panel.unmount();
    dom.window.close();
    for (const key of globalKeys) {
      const descriptor = previousGlobals.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
