import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { ProxyService, type ProxySessionInfo } from './server.js';

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
    const info = await service.openProxyPage({ href: 'https://example.test/page', originalHref: 'https://example.test/page', protocol: 'https' });
    const page = await read(info, info.path, { headers: { cookie: 'harbors-secret=must-not-forward' } });
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, new RegExp(`/preview-proxy/${info.sessionId}/[^"']+`));
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

test('pins Node lookup in both scalar and all-address callback forms', async () => {
  const lookups: Array<(hostname: string, options: any, callback: any) => void> = [];
  const service = new ProxyService({ lookupImpl: publicLookup, requestImpl: async (_url, options) => {
    lookups.push(options.lookup);
    return response('<p>ok</p>');
  }});
  try {
    const info = await service.openProxyPage({ href: 'https://example.test/page' });
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
    service.openProxyPage({ href: 'https://example.test/one' }),
    service.openProxyPage({ href: 'https://example.test/two' }),
    service.openProxyPage({ href: 'https://example.test/three' }),
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
    const info = await service.openProxyPage({ href: 'https://example.test/start' });
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
    const first = await service.openProxyPage({ href: 'https://example.test/page' });
    await assert.rejects(() => service.openProxyPage({ href: 'https://example.test/second' }), /会话数量已达上限/);
    assert.equal((await read(first)).status, 502);
  } finally {
    await service.close();
  }
});

test('periodically removes expired sessions so capacity can be reused', async () => {
  let now = 1000;
  const service = new ProxyService({ now: () => now, sessionTtlMs: 10, cleanupIntervalMs: 5, maxSessions: 1, lookupImpl: publicLookup, requestImpl: async () => response('ok') });
  try {
    await service.openProxyPage({ href: 'https://example.test/page' });
    now = 1011;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.doesNotReject(() => service.openProxyPage({ href: 'https://example.test/second' }));
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
    const first = await service.openProxyPage({ href: 'https://example.test/a' });
    await read(first, first.path, { headers: { cookie: 'harbors=secret' } });
    const second = await service.openProxyPage({ href: 'https://example.test/b' });
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
    await assert.rejects(() => service.openProxyPage({ href: 'http://127.0.0.1/private' }), /本地主机|非公网/);
    const info = await service.openProxyPage({ href: 'https://example.test/page' });
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
    const info = await service.openProxyPage({ href: 'https://example.test/page' });
    const redirect = await read(info);
    assert.equal(redirect.status, 502);
    assert.match(await redirect.text(), /网页代理暂时无法加载/);
    await assert.rejects(() => service.openProxyPage({ href: 'https://[0:0:0:0:0:ffff:c0a8:0101]/' }), /非公网/);
    await assert.rejects(() => service.openProxyPage({ href: 'https://[ff02::1]/' }), /非公网/);
  } finally {
    await service.close();
  }
});

test('expires sessions and closes them explicitly', async () => {
  let now = 1000;
  const service = new ProxyService({ now: () => now, sessionTtlMs: 10, lookupImpl: publicLookup, requestImpl: async () => response('ok') });
  try {
    const info = await service.openProxyPage({ href: 'https://example.test/page' });
    assert.equal((await read(info, info.path)).status, 200);
    now = 1011;
    assert.equal((await read(info, info.path)).status, 410);
    assert.equal(await service.closeProxyPage({ sessionId: info.sessionId }), false);
  } finally {
    await service.close();
  }
});
