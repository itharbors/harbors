import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { appendSessionId } from './index.ts';
import definition from './index.ts';

test('appends sessionId without dropping existing query parameters', () => {
  assert.equal(appendSessionId('/api/settings.html?theme=dark', 'session-1', 'https://host.test/settings'), '/api/settings.html?theme=dark&sessionId=session-1');
});

test('starts the settings shell at the panel root without a header toolbar', async () => {
  const dom = new JSDOM('<div id="panel-root"></div>', { url: 'https://host.test/panel' });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  try {
    await definition.mount({
      sessionId: 'host',
      message: { request(_plugin, name) {
        return name === 'getPages' ? Promise.resolve([]) : Promise.resolve({ ok: true });
      } },
    });
    const root = dom.window.document.getElementById('panel-root') as HTMLElement;
    assert.equal(root.firstElementChild?.className, 'settings-shell');
    assert.equal(root.querySelector('.panel-header'), null);
    assert.equal(root.querySelector('#refresh-btn'), null);
    assert.equal(root.querySelector('#settings-pages')?.parentElement, root.firstElementChild);
    assert.equal(root.querySelector('#settings-content')?.parentElement, root.firstElementChild);
  } finally {
    definition.unmount?.();
    Object.assign(globalThis, { window: previousWindow, document: previousDocument });
  }
});

test('does not proxy iframe postMessage requests', async () => {
  const dom = new JSDOM('<div id="panel-root"></div>', { url: 'https://host.test/panel?sessionId=host' });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  const calls: unknown[][] = [];
  try {
    await definition.mount({
      sessionId: 'host',
      message: {
        request(_plugin: string, name: string, ...args: unknown[]) {
          calls.push([name, ...args]);
          return name === 'getPages'
            ? Promise.resolve([{ owner: 'owner', panel: 'owner.settings', title: '页面', order: 0, entry: '/owner.html' }])
            : Promise.resolve({ ok: true });
        },
      },
    });
    const request = { type: 'settings-page-request', requestId: 'known', name: 'save', args: [1] };
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: request, source: dom.window }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls, ['getPages'].map((name) => [name]));
    definition.unmount?.();
  } finally {
    Object.assign(globalThis, { window: previousWindow, document: previousDocument });
  }
});

test('clicking a page creates one iframe for the selected page', async () => {
  const dom = new JSDOM('<div id="panel-root"></div>', { url: 'https://host.test/panel' });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  let iframeCreates = 0;
  const createElement = dom.window.document.createElement;
  dom.window.document.createElement = function (name: string, options?: ElementCreationOptions) {
    if (name.toLowerCase() === 'iframe') iframeCreates += 1;
    return createElement.call(this, name, options);
  } as typeof dom.window.document.createElement;
  try {
    await definition.mount({
      sessionId: 'host',
      message: { request(_plugin, name) {
        return name === 'getPages'
          ? Promise.resolve([
            { owner: 'a', panel: 'a.settings', title: 'A', order: 0, entry: '/a.html' },
            { owner: 'b', panel: 'b.settings', title: 'B', order: 1, entry: '/b.html' },
          ])
          : Promise.resolve({ ok: true });
      } },
    });
    assert.equal(iframeCreates, 1);
    (dom.window.document.querySelector('[data-panel="b.settings"]') as HTMLButtonElement).click();
    assert.equal(iframeCreates, 2);
    assert.equal(dom.window.document.querySelectorAll('iframe').length, 1);
  } finally {
    definition.unmount?.();
    Object.assign(globalThis, { window: previousWindow, document: previousDocument });
  }
});
