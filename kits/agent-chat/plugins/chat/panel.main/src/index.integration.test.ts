import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('mounted panel keeps a cached draft when the initial getState snapshot is stale', async () => {
  const dom = new JSDOM('<!doctype html><div id="panel-root"></div>', { url: 'http://127.0.0.1:49380/panel' });
  dom.window.requestAnimationFrame = (callback: FrameRequestCallback): number => dom.window.setTimeout(() => callback(Date.now()), 0);
  dom.window.cancelAnimationFrame = (handle: number): void => dom.window.clearTimeout(handle);
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
});
