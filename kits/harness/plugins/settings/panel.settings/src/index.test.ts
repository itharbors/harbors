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
  const style = dom.window.document.createElement('style');
  style.setAttribute('data-harness-ui', '');
  dom.window.document.head.append(style);
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
    const initialFrame = dom.window.document.querySelector('iframe');
    const firstPage = dom.window.document.querySelector<HTMLButtonElement>('[data-panel="a.settings"]')!;
    assert.ok(firstPage.classList.contains('h-list-item'));
    assert.equal(firstPage.getAttribute('aria-pressed'), 'true');
    firstPage.click();
    assert.equal(iframeCreates, 1, 'reselecting the current page must keep its iframe');
    assert.equal(dom.window.document.querySelector('iframe'), initialFrame);
    (dom.window.document.querySelector('[data-panel="b.settings"]') as HTMLButtonElement).click();
    assert.equal(iframeCreates, 2);
    assert.equal(dom.window.document.querySelectorAll('iframe').length, 1);
    const secondFrame = dom.window.document.querySelector('iframe');
    const secondPage = dom.window.document.querySelector<HTMLButtonElement>('[data-panel="b.settings"]')!;
    assert.equal(secondPage.getAttribute('aria-pressed'), 'true');
    secondPage.click();
    assert.equal(iframeCreates, 2);
    assert.equal(dom.window.document.querySelector('iframe'), secondFrame);
  } finally {
    definition.unmount?.();
    Object.assign(globalThis, { window: previousWindow, document: previousDocument });
  }
});

test('switching a focused page keeps focus on its replacement without stealing outside focus', async () => {
  const dom = new JSDOM('<input id="outside"><div id="panel-root"></div>', { url: 'https://host.test/panel' });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  try {
    await definition.mount({
      sessionId: 'host',
      message: { async request() { return [
        { owner: 'a', panel: 'a.settings', title: '页面 A', order: 0, entry: '/a.html' },
        { owner: 'b', panel: 'b.settings', title: '界面规范', order: 1, entry: '/b.html' },
      ]; } },
    });
    const next = dom.window.document.querySelector<HTMLButtonElement>('[data-panel="b.settings"]')!;
    next.focus();
    assert.equal(dom.window.document.activeElement, next);
    next.click();
    const selected = dom.window.document.querySelector<HTMLButtonElement>('[data-panel="b.settings"]')!;
    assert.notEqual(selected, next);
    assert.equal(dom.window.document.activeElement, selected);
    assert.equal(selected.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(
      Array.from(dom.window.document.querySelectorAll('#settings-pages button')).map((item) => item.textContent),
      ['页面 A', '界面规范'],
    );
    const frame = dom.window.document.querySelector('iframe');
    selected.click();
    assert.equal(dom.window.document.activeElement, selected);
    assert.equal(dom.window.document.querySelector('iframe'), frame);

    const outside = dom.window.document.querySelector<HTMLInputElement>('#outside')!;
    outside.focus();
    dom.window.document.querySelector<HTMLButtonElement>('[data-panel="a.settings"]')!.click();
    assert.equal(dom.window.document.activeElement, outside, 'programmatic selection must not steal focus');
  } finally {
    definition.unmount?.();
    Object.assign(globalThis, { window: previousWindow, document: previousDocument });
    dom.window.close();
  }
});

test('installs shared styles on every accessible child document without breaking fallback', async () => {
  const dom = new JSDOM('<div id="panel-root"></div>', { url: 'https://host.test/panel' });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  try {
    await definition.mount({
      sessionId: 'host',
      message: { async request() { return [{ owner: 'a', panel: 'a.settings', title: 'A', order: 0, entry: '/a.html' }]; } },
    });
    const frame = dom.window.document.querySelector('iframe')!;
    const first = dom.window.document.implementation.createHTMLDocument('first');
    const second = dom.window.document.implementation.createHTMLDocument('second');
    let current = first;
    Object.defineProperty(frame, 'contentDocument', { configurable: true, get: () => current });
    const installed: Document[] = [];
    Object.assign(dom.window, { HarnessUI: { install(document: Document) { installed.push(document); } } });
    frame.dispatchEvent(new dom.window.Event('load'));
    current = second;
    frame.dispatchEvent(new dom.window.Event('load'));
    assert.deepEqual(installed, [first, second]);
    Object.defineProperty(frame, 'contentDocument', { configurable: true, get() { throw new dom.window.DOMException('cross-origin', 'SecurityError'); } });
    assert.doesNotThrow(() => frame.dispatchEvent(new dom.window.Event('load')));
    delete (dom.window as unknown as { HarnessUI?: unknown }).HarnessUI;
    assert.doesNotThrow(() => frame.dispatchEvent(new dom.window.Event('load')));
    assert.equal(dom.window.document.querySelector('iframe'), frame);
  } finally {
    definition.unmount?.();
    Object.assign(globalThis, { window: previousWindow, document: previousDocument });
    dom.window.close();
  }
});

test('propagates theme changes and removed tokens to the current settings page', async () => {
  const dom = new JSDOM('<div id="panel-root"></div>', { url: 'https://host.test/panel' });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  try {
    dom.window.document.documentElement.style.setProperty('--ce-surface', '#123456');
    dom.window.document.documentElement.style.setProperty('--ce-old', 'red');
    await definition.mount({ sessionId: 'host', message: { async request() { return [{ owner: 'a', panel: 'a.settings', title: 'A', order: 0, entry: '/a.html' }]; } } });
    const frame = dom.window.document.querySelector('iframe')!;
    const child = dom.window.document.implementation.createHTMLDocument('child');
    Object.defineProperty(frame, 'contentDocument', { configurable: true, get: () => child });
    frame.dispatchEvent(new dom.window.Event('load'));
    const theme = child.head.querySelector('style[data-settings-theme]')!;
    assert.match(theme.textContent!, /--ce-surface: #123456/);
    dom.window.document.documentElement.style.setProperty('--ce-surface', '#abcdef');
    dom.window.document.documentElement.style.removeProperty('--ce-old');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(theme.textContent!, /--ce-surface: #abcdef/);
    assert.doesNotMatch(theme.textContent!, /--ce-old/);
    definition.unmount();
    dom.window.document.documentElement.style.setProperty('--ce-surface', '#000000');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(theme.textContent!, /--ce-surface: #abcdef/);
  } finally {
    definition.unmount();
    Object.assign(globalThis, { window: previousWindow, document: previousDocument });
    dom.window.close();
  }
});
