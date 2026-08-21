import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('mount click switches web modes and delegates retry/close events', async () => {
  const dom = new JSDOM('<!doctype html><div id="panel-root"></div>', { url: 'http://127.0.0.1:49380/panel' });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
  });
  const { default: panel } = await import('./index.ts');
  const requests: string[] = [];
  let resolveState!: (value: unknown) => void;
  const statePromise = new Promise<unknown>((resolve) => { resolveState = resolve; });
  const context = {
    message: {
      async request(_plugin: string, name: string, payload?: any): Promise<unknown> {
        requests.push(name);
        if (name === 'getState') return statePromise;
        if (name === 'openProxyPage') {
          return {
            sessionId: `session-${payload.href.slice(-1)}`,
            port: 49381,
            path: `/preview-proxy/session-${payload.href.slice(-1)}/root`,
            expiresAt: Date.now() + 60_000,
          };
        }
        if (name === 'fetchWebPage') {
          return { kind: 'url', url: payload.href, title: '网页', snapshotHtml: '<h1>snapshot</h1>', directAllowed: false };
        }
        return true;
      },
    },
  };

  await panel.mount(context);
  await panel.methods.onLinkClicked({ href: 'https://example.test/a', originalHref: 'https://example.test/a', protocol: 'https', text: 'A' });
  await panel.methods.onLinkClicked({ href: 'https://example.test/b', originalHref: 'https://example.test/b', protocol: 'https', text: 'B' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  resolveState({ selectedConversationId: 'stale-mount-selection' });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const view = document.querySelector<HTMLElement>('.preview-tab-view[data-preview-tab-id="tab-2"]');
  assert.ok(view);
  assert.equal(view.dataset.previewSessionKey, 'empty');
  const snapshot = view.querySelector<HTMLButtonElement>('[data-preview-web-mode="snapshot"]');
  assert.ok(snapshot);
  assert.equal(snapshot.disabled, false);
  snapshot.click();
  assert.ok(view.querySelector('iframe[srcdoc]'));
  assert.equal(view.querySelector<HTMLButtonElement>('[data-preview-web-mode="snapshot"]')?.disabled, true);

  view.querySelector<HTMLButtonElement>('[data-preview-web-mode="direct"]')?.click();
  assert.ok(view.querySelector('iframe[src]'));
  assert.equal(view.querySelector<HTMLButtonElement>('[data-preview-web-mode="direct"]')?.disabled, true);

  view.querySelector<HTMLButtonElement>('[data-preview-web-retry]')?.click();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(view.querySelector('iframe[src]'));
  assert.ok(requests.filter((name) => name === 'fetchWebPage').length >= 3);

  document.querySelector<HTMLButtonElement>('[data-preview-close-id="tab-2"]')?.click();
  assert.equal(document.querySelector('.preview-tab-view[data-preview-tab-id="tab-2"]'), null);
  assert.ok(requests.includes('closeProxyPage'));
});
