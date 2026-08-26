import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('mount keeps one proxy iframe while viewport size and interaction mode change', async () => {
  const dom = new JSDOM('<!doctype html><div id="panel-root"></div>', { url: 'http://127.0.0.1:49380/panel' });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
  });
  const { default: panel } = await import('./index.ts');
  const requests: Array<{ name: string; payload: any }> = [];
  let resolveState!: (value: unknown) => void;
  const statePromise = new Promise<unknown>((resolve) => { resolveState = resolve; });
  const context = {
    message: {
      async request(_plugin: string, name: string, payload?: any): Promise<unknown> {
        requests.push({ name, payload });
        if (name === 'getState') return statePromise;
        if (name === 'openProxyPage') {
          return {
            sessionId: `session-${payload.href.slice(-1)}`,
            port: 49381,
            path: `/preview-proxy/session-${payload.href.slice(-1)}/root`,
            expiresAt: Date.now() + 60_000,
          };
        }
        if (name === 'readFile') {
          return { kind: 'file', title: 'unsafe.html', language: 'html', content: '<script>bad()</script><h1>code</h1>' };
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
  const frame = view.querySelector('iframe');
  assert.ok(frame);
  const width = view.querySelector<HTMLInputElement>('[data-preview-viewport-width]');
  assert.ok(width);
  width.value = '1600';
  width.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(view.querySelector('iframe'), frame);
  assert.equal(view.querySelector<HTMLElement>('[data-preview-web-canvas]')?.style.width, '1600px');

  view.querySelector<HTMLButtonElement>('[data-preview-interaction-mode="virtual"]')?.click();
  assert.equal(view.querySelector('iframe'), frame);
  const layer = view.querySelector<HTMLElement>('[data-preview-gesture-layer]');
  assert.ok(layer);
  assert.equal(view.querySelector<HTMLButtonElement>('[data-preview-interaction-mode="virtual"]')?.getAttribute('aria-pressed'), 'true');
  const posted: any[] = [];
  frame.contentWindow!.postMessage = ((message: unknown) => { posted.push(message); }) as typeof frame.contentWindow.postMessage;
  const pointer = (type: string, x: number, y: number, pointerId = 1) => {
    const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    Object.defineProperties(event, { isPrimary: { value: true }, pointerId: { value: pointerId } });
    layer.dispatchEvent(event);
  };
  pointer('pointerdown', 20, 20);
  pointer('pointerup', 20, 20);
  assert.deepEqual(posted.map((message) => message.command), ['click']);
  pointer('pointerdown', 20, 20, 2);
  pointer('pointermove', 40, 20, 2);
  pointer('pointerup', 40, 20, 2);
  assert.deepEqual(posted.map((message) => message.command), ['click', 'move']);
  pointer('pointerdown', 20, 20, 3);
  await new Promise((resolve) => setTimeout(resolve, 570));
  pointer('pointerup', 20, 20, 3);
  assert.deepEqual(posted.map((message) => message.command), ['click', 'move', 'contextmenu']);
  view.querySelector<HTMLButtonElement>('[data-preview-interaction-mode="direct"]')?.click();
  assert.equal(view.querySelector('iframe'), frame);
  assert.equal(view.querySelector('[data-preview-gesture-layer]'), null);
  assert.equal(requests.filter((entry) => entry.name === 'openProxyPage').length, 2);
  assert.equal(requests.some((entry) => entry.name === 'fetchWebPage'), false);
  assert.equal(requests.find((entry) => entry.name === 'openProxyPage')?.payload.controlOrigin, 'http://127.0.0.1:49380');

  document.querySelector<HTMLButtonElement>('[data-preview-close-id="tab-2"]')?.click();
  assert.equal(document.querySelector('.preview-tab-view[data-preview-tab-id="tab-2"]'), null);
  assert.ok(requests.some((entry) => entry.name === 'closeProxyPage'));

  await panel.methods.onLinkClicked({ href: 'file:///tmp/unsafe.html', originalHref: 'file:///tmp/unsafe.html', protocol: 'file', text: 'HTML' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const htmlView = document.querySelector<HTMLElement>('.preview-tab-view[data-preview-tab-id="tab-3"]');
  assert.ok(htmlView);
  assert.equal(htmlView.querySelector('script'), null);
  assert.match(htmlView.textContent || '', /<script>bad\(\)<\/script>/);
});
