import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('built panel bundle switches a mounted web tab to a snapshot on click', async () => {
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
        if (name === 'fetchWebPage') {
          return { kind: 'url', url: payload.href, title: '网页', snapshotHtml: '<h1>built snapshot</h1>', directAllowed: false };
        }
        return true;
      },
    },
  };

  await panel.mount(context);
  await panel.methods.onLinkClicked({ href: 'https://example.test/built', originalHref: 'https://example.test/built', protocol: 'https', text: 'built' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const button = document.querySelector<HTMLButtonElement>('[data-preview-web-mode="snapshot"]');
  assert.ok(button);
  assert.equal(button.disabled, false);
  button.click();
  assert.ok(document.querySelector('iframe[srcdoc]'));
  assert.equal(document.querySelector<HTMLButtonElement>('[data-preview-web-mode="snapshot"]')?.disabled, true);
  document.querySelector<HTMLButtonElement>('[data-preview-web-mode="direct"]')?.click();
  assert.ok(document.querySelector('iframe[src]'));
  document.querySelector<HTMLButtonElement>('[data-preview-web-retry]')?.click();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(document.querySelector('iframe[src]'));
  document.querySelector<HTMLButtonElement>('[data-preview-close-id="tab-1"]')?.click();
  assert.equal(document.querySelector('.preview-tab-view'), null);
  assert.ok(requests.includes('closeProxyPage'));
});
