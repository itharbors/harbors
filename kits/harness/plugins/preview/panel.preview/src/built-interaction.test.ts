import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('built panel bundle keeps the proxy iframe while switching interaction modes', async () => {
  const dom = new JSDOM('<!doctype html><div id="panel-root"></div>', { url: 'http://127.0.0.1:49380/panel' });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
  });
  const { default: panel } = await import('../dist/index.js');
  const requests: string[] = [];
  const context = {
    message: {
      async request(_plugin: string, name: string, payload?: any): Promise<unknown> {
        requests.push(name);
        if (name === 'getState') return {};
        if (name === 'openProxyPage') {
          return { sessionId: 'built-session', port: 49391, path: '/preview-proxy/built-session/root', expiresAt: Date.now() + 60_000 };
        }
        return true;
      },
    },
  };

  await panel.mount(context);
  await panel.methods.onLinkClicked({ href: 'https://example.test/built', originalHref: 'https://example.test/built', protocol: 'https', text: 'built' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const frame = document.querySelector('iframe');
  assert.ok(frame);
  document.querySelector<HTMLButtonElement>('[data-preview-interaction-mode="virtual"]')?.click();
  assert.equal(document.querySelector('iframe'), frame);
  assert.ok(document.querySelector('[data-preview-gesture-layer]'));
  document.querySelector<HTMLButtonElement>('[data-preview-interaction-mode="direct"]')?.click();
  assert.equal(document.querySelector('iframe'), frame);
  assert.equal(document.querySelector('[data-preview-gesture-layer]'), null);
  assert.equal(requests.includes('fetchWebPage'), false);
  document.querySelector<HTMLButtonElement>('[data-preview-close-id="tab-1"]')?.click();
  assert.equal(document.querySelector('.preview-tab-view'), null);
  assert.ok(requests.includes('closeProxyPage'));
});
