import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { syncWebContent, webContentMarkup } from './web-view.ts';

const dom = new JSDOM('<!doctype html>');
Object.assign(globalThis, { window: dom.window, document: dom.window.document });

test('renders one fixed-size restricted proxy iframe and accessible viewport controls', () => {
  const markup = webContentMarkup({
    proxyUrl: 'http://127.0.0.1:49391/preview-proxy/session/root',
    proxySessionId: 'session', viewportWidth: 1600, viewportHeight: 1000, interactionMode: 'direct',
  });
  assert.match(markup, /style="width:1600px;height:1000px"/);
  assert.match(markup, /sandbox="allow-scripts"/);
  assert.doesNotMatch(markup, /allow-forms|allow-same-origin|allow-popups|allow-downloads|srcdoc/);
  assert.match(markup, /data-preview-viewport-width/);
  assert.match(markup, /data-preview-interaction-mode="direct" aria-pressed="true"/);
  assert.doesNotMatch(markup, /data-preview-gesture-layer/);
  assert.doesNotMatch(markup, /安全快照|重试快照|fetchWebPage/);
});

test('renders the virtual gesture layer with textual cursor feedback', () => {
  const markup = webContentMarkup({ proxyUrl: 'http://127.0.0.1:49391/page', interactionMode: 'virtual' });
  assert.match(markup, /data-preview-gesture-layer="true" tabindex="0" role="application"/);
  assert.match(markup, /滑动移动，轻点左键，长按右键/);
  assert.match(markup, />虚拟鼠标</);
});

test('syncs mode and size without replacing the existing iframe', () => {
  const view = document.createElement('section');
  view.innerHTML = webContentMarkup({ proxyUrl: 'http://127.0.0.1:49391/page' });
  const frame = view.querySelector('iframe');
  assert.equal(syncWebContent(view, {
    proxyUrl: 'http://127.0.0.1:49391/page', viewportWidth: 1440, viewportHeight: 900, interactionMode: 'virtual',
  }), true);
  assert.equal(view.querySelector('iframe'), frame);
  assert.equal(view.querySelector<HTMLElement>('[data-preview-web-canvas]')?.style.width, '1440px');
  assert.ok(view.querySelector('[data-preview-gesture-layer]'));
  assert.equal(syncWebContent(view, { proxyUrl: 'http://127.0.0.1:49391/page', interactionMode: 'direct' }), true);
  assert.equal(view.querySelector('iframe'), frame);
  assert.equal(view.querySelector('[data-preview-gesture-layer]'), null);
  assert.equal(syncWebContent(view, { proxyUrl: 'http://127.0.0.1:49391/other' }), false);
});

test('shows a proxy-only failure without any fallback iframe', () => {
  const markup = webContentMarkup({ proxyError: 'blocked' });
  assert.match(markup, /代理失败：blocked/);
  assert.doesNotMatch(markup, /iframe|srcdoc|安全快照/);
});
