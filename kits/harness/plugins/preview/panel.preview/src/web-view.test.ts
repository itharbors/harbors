import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { webContentMarkup } from './web-view.ts';

const dom = new JSDOM('<!doctype html>');
Object.assign(globalThis, { window: dom.window, document: dom.window.document });
const { sanitizeSnapshotHtml } = await import('./index.ts');

test('renders direct pages with an explicit web sandbox and a snapshot switch', () => {
  const markup = webContentMarkup({ url: 'https://example.test/page', mode: 'direct', directAllowed: true });
  assert.match(markup, /sandbox="" referrerpolicy="no-referrer"/);
  assert.match(markup, /data-preview-web-mode="snapshot"/);
  assert.match(markup, /网页直连可能受目标站点嵌入策略限制/);
});

test('renders the proxy iframe with only the required sandbox capabilities', () => {
  const markup = webContentMarkup({
    url: 'http://example.test/page',
    proxyUrl: 'http://127.0.0.1:49391/preview/session/test',
    proxyLoading: false,
    mode: 'direct',
  });
  assert.match(markup, /src="http:\/\/127\.0\.0\.1:49391\/preview\/session\/test"/);
  assert.match(markup, /sandbox="allow-scripts"/);
  assert.doesNotMatch(markup, /allow-forms|allow-same-origin/);
  assert.match(markup, /referrerpolicy="no-referrer"/);
  assert.doesNotMatch(markup, /allow-top-navigation|allow-popups|allow-downloads/);
  assert.match(markup, /首版限制登录、表单和部分交互/);
});

test('renders snapshots in srcdoc without scripts or same-origin permission', () => {
  const markup = webContentMarkup({
    url: 'https://example.test/page',
    mode: 'snapshot',
    snapshotHtml: '<script>alert("not parent")</script><img src="image.png">',
  });
  assert.match(markup, /sandbox="" referrerpolicy="no-referrer"><\/iframe>/);
  assert.match(markup, /srcdoc="&lt;!doctype html/);
  assert.match(markup, /&lt;script&gt;alert/);
  assert.doesNotMatch(markup, /srcdoc="[^\"]*allow-scripts/);
  assert.match(markup, /Content-Security-Policy/);
});

test('sanitizes snapshot resource and executable elements', () => {
  const clean = sanitizeSnapshotHtml('<script>x()</script><img src="x"><link href="x"><svg></svg><div onclick="x()" style="color:red">ok</div>');
  assert.doesNotMatch(clean, /script|img|link|svg|onclick/);
  assert.match(clean, /style="color:red"/);
});

test('renders local HTML as an offline snapshot without a file direct iframe', () => {
  const markup = webContentMarkup({
    url: 'file:///tmp/example.html',
    mode: 'snapshot',
    directAllowed: false,
    snapshotHtml: '<h1>Local</h1>',
  });
  assert.match(markup, /Content-Security-Policy/);
  assert.doesNotMatch(markup, /src="file:/);
  assert.match(markup, /srcdoc=/);
});
