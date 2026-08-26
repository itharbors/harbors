import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { ProxyService, injectPointerBridge, normalizeControlOrigin, type ProxySessionInfo } from './server.js';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 as const }];

function response(body: string, headers: Record<string, string | string[]> = {}, statusCode = 200) {
  return {
    statusCode,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
    body: Readable.from([Buffer.from(body)]),
  };
}

async function read(info: ProxySessionInfo, path = info.path, init?: RequestInit): Promise<Response> {
  return fetch(`http://127.0.0.1:${info.port}${path}`, init);
}

test('rewrites HTML/CSS resources and removes frame embedding restrictions', async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const service = new ProxyService({ lookupImpl: publicLookup, requestImpl: async (url, options) => {
    calls.push({ url: url.href, headers: options.headers });
    if (url.pathname === '/page') return response('<html><head><link href="/style.css"></head><body><img src="/figure.png"><a href="/next">next</a></body></html>', {
      'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
      'x-frame-options': 'DENY',
      'set-cookie': 'sid=one; Path=/',
    });
    if (url.pathname === '/style.css') return response('body { background: url("/figure.png") } @import "/more.css"', { 'content-type': 'text/css' });
    return { statusCode: 200, headers: { 'content-type': 'image/png' }, body: Readable.from([Buffer.from('png')]) };
  }});
  try {
    const info = await service.openProxyPage({ href: 'https://example.test/page', controlOrigin: 'http://127.0.0.1:49380' });
    const page = await read(info, info.path, { headers: { cookie: 'harbors-secret=must-not-forward' } });
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, new RegExp(`/preview-proxy/${info.sessionId}/[^"']+`));
    assert.match(html, /harbors\.preview\.pointer/);
    assert.match(html, /event\.source !== parent/);
    assert.match(html, /event\.origin !== controlOrigin/);
    assert.doesNotMatch(html, /frame-ancestors|x-frame-options/i);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    const pageCsp = page.headers.get('content-security-policy') || '';
    assert.match(pageCsp, /connect-src 'self'/);
    assert.match(pageCsp, /form-action 'none'/);
    assert.match(pageCsp, /frame-src 'none'/);
    assert.match(pageCsp, /object-src 'none'/);
    assert.match(pageCsp, /base-uri 'none'/);
    assert.match(pageCsp, /script-src 'self'.*data: blob:/);
    assert.doesNotMatch(pageCsp, /example\.test|frame-ancestors/);
    assert.equal(calls[0].headers.cookie, undefined);

    const stylePath = [...html.matchAll(/href="([^"]+)"/gi)][0]?.[1];
    assert.ok(stylePath);
    const style = await read(info, stylePath);
    assert.match(await style.text(), /\/preview-proxy\//);
    assert.equal(style.headers.get('content-security-policy'), pageCsp);
    assert.equal(calls.find((call) => call.url.endsWith('/style.css'))?.headers.cookie, 'sid=one');
  } finally {
    await service.close();
  }
});

test('accepts only a canonical HTTP control origin', () => {
  assert.equal(normalizeControlOrigin('http://127.0.0.1:49380'), 'http://127.0.0.1:49380');
  for (const value of [
    'https://harbors.test', 'http://user@harbors.test', 'http://harbors.test/',
    'http://harbors.test/path', 'http://harbors.test?x=1', 'not a url',
  ]) assert.throws(() => normalizeControlOrigin(value), /控制来源无效/);
});

test('pointer bridge binds source, origin, session, schema, integer coordinates, and actual viewport', () => {
  const html = injectPointerBridge('<button id="target">target</button>', 'session-safe', 'http://harbors.test');
  const dom = new JSDOM(html, { url: 'http://proxy.test', runScripts: 'dangerously' });
  const { window } = dom;
  const target = window.document.getElementById('target')!;
  Object.defineProperty(window.document, 'elementFromPoint', { value: () => target });
  let clicks = 0;
  target.addEventListener('click', () => { clicks += 1; });
  const valid = {
    version: 1, type: 'harbors.preview.pointer', sessionId: 'session-safe', command: 'click',
    x: 10, y: 10, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
  };
  const send = (data: unknown, origin = 'http://harbors.test', source: Window | null = window) => {
    window.dispatchEvent(new window.MessageEvent('message', { data, origin, source }));
  };
  send(valid, 'http://attacker.test');
  send(valid, 'http://harbors.test', null);
  send({ ...valid, sessionId: 'wrong' });
  send({ ...valid, command: 'script' });
  send({ ...valid, x: 1.5 });
  send({ ...valid, x: Number.NaN });
  send({ ...valid, x: window.innerWidth });
  send({ ...valid, viewportWidth: window.innerWidth - 1 });
  send({ ...valid, selector: '#target' });
  assert.equal(clicks, 0);
  send(valid);
  assert.equal(clicks, 1);
  dom.window.close();
});

test('serializes bridge constants without allowing script breakout', () => {
  const html = injectPointerBridge('<p>ok</p>', '</script><script>bad()</script>', 'http://harbors.test');
  assert.doesNotMatch(html, /<script>bad\(\)<\/script>/);
  assert.match(html, /\\u003c\/script\\u003e/);
});

test('injects before the real closing body while ignoring non-data HTML contexts', () => {
  const source = [
    '<!doctype html><html><head>',
    '<title>title </body> text</title>',
    '<style>.sample::after { content: "</body>" }</style>',
    '</head><body data-value="</body>">',
    '<!-- comment </body> -->',
    '<script>',
    'const quoted = "</body>";',
    'const template = `</body>`;',
    '// </body>',
    '/* </body> */',
    '</script>',
    '<textarea>text </body> value</textarea>',
    '<xmp>xmp </body> value</xmp>',
    '<iframe>iframe </body> value</iframe>',
    '<noembed>noembed </body> value</noembed>',
    '<noframes>noframes </body> value</noframes>',
    '<noscript>noscript </body> value</noscript>',
    '<p>content</p></body></html>',
  ].join('\n');
  const injected = injectPointerBridge(source, 'session', 'http://harbors.test');
  const bridge = injected.indexOf('harbors.preview.pointer');
  const scriptClose = injected.indexOf('</script>');
  const realBodyClose = injected.lastIndexOf('</body>');
  assert.ok(bridge > scriptClose);
  assert.ok(bridge < realBodyClose);
  assert.equal(injected.slice(realBodyClose), '</body></html>');

  const htmlFallback = injectPointerBridge('<html><main>bodyless</main></html>', 'session', 'http://harbors.test');
  assert.ok(htmlFallback.indexOf('harbors.preview.pointer') < htmlFallback.indexOf('</html>'));
  const appendFallback = injectPointerBridge('<main>fragment</main>', 'session', 'http://harbors.test');
  assert.match(appendFallback, /<\/main><script>/);
});

test('injects before HTML plaintext so the bridge remains executable', () => {
  const source = '<!doctype html><html><body><button id="target">target</button><plaintext>literal </body><script>bad()</script></html>';
  const injected = injectPointerBridge(source, 'session-safe', 'http://harbors.test');
  assert.ok(injected.indexOf('harbors.preview.pointer') < injected.indexOf('<plaintext>'));
  const dom = new JSDOM(injected, { url: 'http://proxy.test', runScripts: 'dangerously' });
  const { window } = dom;
  const target = window.document.getElementById('target')!;
  Object.defineProperty(window.document, 'elementFromPoint', { value: () => target });
  let clicks = 0;
  target.addEventListener('click', () => { clicks += 1; });
  window.dispatchEvent(new window.MessageEvent('message', {
    source: window,
    origin: 'http://harbors.test',
    data: {
      version: 1, type: 'harbors.preview.pointer', sessionId: 'session-safe', command: 'click',
      x: 10, y: 10, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
    },
  }));
  assert.equal(clicks, 1);
  assert.match(window.document.querySelector('plaintext')?.textContent || '', /literal <\/body><script>bad\(\)<\/script><\/html>/);
  dom.window.close();
});

test('requires a valid HTML tag-name delimiter before recognizing closing tags', () => {
  const scriptSource = '<html><body><script>const s="</script.foo> </body>";</script><button>x</button></body></html>';
  const scriptInjected = injectPointerBridge(scriptSource, 'session', 'http://harbors.test');
  assert.ok(scriptInjected.indexOf('harbors.preview.pointer') > scriptInjected.indexOf('</script><button>'));
  assert.ok(scriptInjected.indexOf('harbors.preview.pointer') < scriptInjected.lastIndexOf('</body>'));

  const bodySource = '<html><body><p>before</p></body.foo><button>after</button></body></html>';
  const bodyInjected = injectPointerBridge(bodySource, 'session', 'http://harbors.test');
  assert.ok(bodyInjected.indexOf('harbors.preview.pointer') > bodyInjected.indexOf('</body.foo>'));
  assert.ok(bodyInjected.indexOf('harbors.preview.pointer') < bodyInjected.lastIndexOf('</body>'));
});

test('serves an XML-safe bridge for application/xhtml+xml', async () => {
  const source = '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>ok</p></body></html>';
  const service = new ProxyService({
    lookupImpl: publicLookup,
    requestImpl: async () => response(source, { 'content-type': 'application/xhtml+xml' }),
  });
  try {
    const info = await service.openProxyPage({ href: 'https://example.test/page.xhtml', controlOrigin: 'http://127.0.0.1:49380' });
    const served = await (await read(info)).text();
    assert.match(served, /<script type="application\/javascript"><!\[CDATA\[/);
    assert.ok(served.indexOf('harbors.preview.pointer') < served.indexOf('</body>'));
    const parser = new JSDOM('').window.DOMParser;
    const document = new parser().parseFromString(served, 'application/xhtml+xml');
    assert.equal(document.querySelector('parsererror'), null);
    assert.match(document.querySelector('script')?.textContent || '', /addEventListener\('message'/);
  } finally {
    await service.close();
  }
});

test('pins Node lookup in both scalar and all-address callback forms', async () => {
  const lookups: Array<(hostname: string, options: any, callback: any) => void> = [];
  const service = new ProxyService({ lookupImpl: publicLookup, requestImpl: async (_url, options) => {
    lookups.push(options.lookup);
    return response('<p>ok</p>');
  }});
  try {
    const info = await service.openProxyPage({ href: 'https://example.test/page', controlOrigin: 'http://127.0.0.1:49380' });
    assert.equal((await read(info)).status, 200);
    assert.equal(lookups.length, 1);
    let allResult: unknown;
    lookups[0]('example.test', { all: true }, (_error: unknown, address: unknown) => { allResult = address; });
    assert.deepEqual(allResult, [{ address: '93.184.216.34', family: 4 }]);
    let scalarResult: unknown;
    let scalarFamily: unknown;
    lookups[0]('example.test', { all: false }, (_error: unknown, address: unknown, family: unknown) => {
      scalarResult = address;
      scalarFamily = family;
    });
    assert.equal(scalarResult, '93.184.216.34');
    assert.equal(scalarFamily, 4);
  } finally {
    await service.close();
  }
});

test('coalesces concurrent server startup and closes the listener without leftovers', async () => {
  const service = new ProxyService({ lookupImpl: async () => {
    await Promise.resolve();
    return [{ address: '93.184.216.34', family: 4 as const }];
  }, requestImpl: async () => response('<p>ok</p>') });
  const infos = await Promise.all([
    service.openProxyPage({ href: 'https://example.test/one', controlOrigin: 'http://127.0.0.1:49380' }),
    service.openProxyPage({ href: 'https://example.test/two', controlOrigin: 'http://127.0.0.1:49380' }),
    service.openProxyPage({ href: 'https://example.test/three', controlOrigin: 'http://127.0.0.1:49380' }),
  ]);
  assert.equal(new Set(infos.map((info) => info.port)).size, 1);
  await service.close();
  await assert.rejects(() => fetch(`http://127.0.0.1:${infos[0].port}${infos[0].path}`));
});

test('keeps cookies host-only and applies RFC path boundaries', async () => {
  const seen: Array<{ path: string; cookie: string }> = [];
  const service = new ProxyService({ lookupImpl: publicLookup, requestImpl: async (url, options) => {
    seen.push({ path: url.pathname, cookie: options.headers.cookie || '' });
    if (url.pathname === '/start') return response('<a href="/foo/bar">bar</a><a href="/foobar">not-bar</a><a href="https://sub.example.test/sibling">sibling</a>', {
      'set-cookie': 'token=one; Domain=example.test; Path=/foo',
    });
    return response('<p>ok</p>');
  }});
  try {
    const info = await service.openProxyPage({ href: 'https://example.test/start', controlOrigin: 'http://127.0.0.1:49380' });
    const html = await (await read(info)).text();
    const paths = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
    await read(info, paths[0]);
    await read(info, paths[1]);
    await read(info, paths[2]);
    assert.equal(seen.find((call) => call.path === '/foo/bar')?.cookie, 'token=one');
    assert.equal(seen.find((call) => call.path === '/foobar')?.cookie, '');
    assert.equal(seen.find((call) => call.path === '/sibling')?.cookie, '');
  } finally {
    await service.close();
  }
});

test('rejects parent-domain cookies and bounds sessions and resources', async () => {
  const service = new ProxyService({ maxSessions: 1, maxResources: 2, lookupImpl: publicLookup, requestImpl: async (url) => {
    if (url.pathname === '/page') return response('<a href="/one">one</a><a href="/two">two</a>', { 'set-cookie': 'token=bad; Domain=com; Path=/' });
    return response('<p>ok</p>');
  }});
  try {
    const first = await service.openProxyPage({ href: 'https://example.test/page', controlOrigin: 'http://127.0.0.1:49380' });
    await assert.rejects(() => service.openProxyPage({ href: 'https://example.test/second', controlOrigin: 'http://127.0.0.1:49380' }), /会话数量已达上限/);
    assert.equal((await read(first)).status, 502);
  } finally {
    await service.close();
  }
});

test('periodically removes expired sessions so capacity can be reused', async () => {
  let now = 1000;
  const service = new ProxyService({ now: () => now, sessionTtlMs: 10, cleanupIntervalMs: 5, maxSessions: 1, lookupImpl: publicLookup, requestImpl: async () => response('ok') });
  try {
    await service.openProxyPage({ href: 'https://example.test/page', controlOrigin: 'http://127.0.0.1:49380' });
    now = 1011;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.doesNotReject(() => service.openProxyPage({ href: 'https://example.test/second', controlOrigin: 'http://127.0.0.1:49380' }));
  } finally {
    await service.close();
  }
});

test('isolates cookies by session and never forwards browser cookies', async () => {
  const seen: string[] = [];
  const service = new ProxyService({ lookupImpl: publicLookup, requestImpl: async (url, options) => {
    seen.push(options.headers.cookie || '');
    return response('<p>ok</p>', { 'set-cookie': 'token=private; Path=/' });
  }});
  try {
    const first = await service.openProxyPage({ href: 'https://example.test/a', controlOrigin: 'http://127.0.0.1:49380' });
    await read(first, first.path, { headers: { cookie: 'harbors=secret' } });
    const second = await service.openProxyPage({ href: 'https://example.test/b', controlOrigin: 'http://127.0.0.1:49380' });
    await read(second, second.path, { headers: { cookie: 'harbors=secret' } });
    assert.equal(seen[0], '');
    assert.equal(seen[1], '');
  } finally {
    await service.close();
  }
});

test('rejects private targets, unknown sessions, and POST requests', async () => {
  const service = new ProxyService({ lookupImpl: publicLookup });
  try {
    await assert.rejects(() => service.openProxyPage({ href: 'http://127.0.0.1/private', controlOrigin: 'http://127.0.0.1:49380' }), /本地主机|非公网/);
    const info = await service.openProxyPage({ href: 'https://example.test/page', controlOrigin: 'http://127.0.0.1:49380' });
    assert.equal((await read(info, '/preview-proxy/nope/root')).status, 404);
    assert.equal((await read(info, info.path, { method: 'POST' })).status, 405);
  } finally {
    await service.close();
  }
});

test('revalidates every redirect target and rejects rebinding-shaped IPv6 answers', async () => {
  const service = new ProxyService({
    lookupImpl: async (hostname) => {
      if (hostname === 'private.example.test') return [{ address: '192.168.1.10', family: 4 as const }];
      return [{ address: '93.184.216.34', family: 4 as const }];
    },
    requestImpl: async (url) => {
      if (url.hostname === 'example.test') return response('', { location: 'http://private.example.test/private' }, 302);
      throw new Error('redirect target must not be requested');
    },
  });
  try {
    const info = await service.openProxyPage({ href: 'https://example.test/page', controlOrigin: 'http://127.0.0.1:49380' });
    const redirect = await read(info);
    assert.equal(redirect.status, 502);
    assert.match(await redirect.text(), /网页代理暂时无法加载/);
    await assert.rejects(() => service.openProxyPage({ href: 'https://[0:0:0:0:0:ffff:c0a8:0101]/', controlOrigin: 'http://127.0.0.1:49380' }), /非公网/);
    await assert.rejects(() => service.openProxyPage({ href: 'https://[ff02::1]/', controlOrigin: 'http://127.0.0.1:49380' }), /非公网/);
  } finally {
    await service.close();
  }
});

test('expires sessions and closes them explicitly', async () => {
  let now = 1000;
  const service = new ProxyService({ now: () => now, sessionTtlMs: 10, lookupImpl: publicLookup, requestImpl: async () => response('ok') });
  try {
    const info = await service.openProxyPage({ href: 'https://example.test/page', controlOrigin: 'http://127.0.0.1:49380' });
    assert.equal((await read(info, info.path)).status, 200);
    now = 1011;
    assert.equal((await read(info, info.path)).status, 410);
    assert.equal(await service.closeProxyPage({ sessionId: info.sessionId }), false);
  } finally {
    await service.close();
  }
});
