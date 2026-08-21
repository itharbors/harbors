import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchWebPage, type RequestImpl } from './web.ts';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 as const }];

function payload(href = 'https://example.test/page') {
  return { href, originalHref: href, protocol: new URL(href).protocol.slice(0, -1) };
}

function response(body: string, init: { status?: number; contentType?: string; location?: string } = {}): RequestImpl {
  return async () => ({
    statusCode: init.status ?? 200,
    headers: {
      'content-type': init.contentType || 'text/html; charset=utf-8',
      ...(init.location ? { location: init.location } : {}),
    },
    body: (async function* () { yield new TextEncoder().encode(body); })(),
  });
}

test('fetches an HTML page and records the final URL for the snapshot base', async () => {
  const result = await fetchWebPage(payload(), {
    requestImpl: response('<h1>Hello</h1>'),
    lookupImpl: publicLookup,
  });
  assert.equal(result.snapshotHtml, '<h1>Hello</h1>');
  assert.equal(result.snapshotBaseUrl, 'https://example.test/page');
  assert.equal(result.snapshotError, undefined);
});

test('pins snapshot requests with both Node lookup callback forms', async () => {
  let pinned: any;
  const result = await fetchWebPage(payload(), {
    lookupImpl: publicLookup,
    requestImpl: async (_url, options) => {
      pinned = options.lookup;
      return response('<h1>Hello</h1>')();
    },
  });
  assert.equal(result.snapshotError, undefined);
  let allResult: unknown;
  pinned('example.test', { all: true }, (_error, address) => { allResult = address; });
  assert.deepEqual(allResult, [{ address: '93.184.216.34', family: 4 }]);
  let scalarResult: unknown;
  pinned('example.test', { all: false }, (_error, address) => { scalarResult = address; });
  assert.equal(scalarResult, '93.184.216.34');
});

test('does not resolve literal IP URLs through a replaceable DNS lookup', async () => {
  let lookupCalls = 0;
  let requestLookup: any;
  const result = await fetchWebPage(payload('https://93.184.216.34/page'), {
    lookupImpl: async () => {
      lookupCalls += 1;
      return [{ address: '127.0.0.1', family: 4 as const }];
    },
    requestImpl: async (_url, options) => {
      requestLookup = options.lookup;
      return response('<h1>Hello</h1>')();
    },
  });
  assert.equal(result.snapshotError, undefined);
  assert.equal(lookupCalls, 0);
  let pinnedAddress: unknown;
  requestLookup('93.184.216.34', { all: true }, (_error: unknown, address: unknown) => { pinnedAddress = address; });
  assert.deepEqual(pinnedAddress, [{ address: '93.184.216.34', family: 4 }]);
});

test('rejects non-HTML responses and HTTP errors without exposing a snapshot', async () => {
  const contentType = await fetchWebPage(payload(), {
    requestImpl: response('{}', { contentType: 'application/json' }),
    lookupImpl: publicLookup,
  });
  assert.match(contentType.snapshotError || '', /不是 HTML/);

  const status = await fetchWebPage(payload(), {
    requestImpl: response('nope', { status: 403 }),
    lookupImpl: publicLookup,
  });
  assert.match(status.snapshotError || '', /HTTP 403/);
});

test('reports timeouts and oversized response bodies', async () => {
  const timeout = await fetchWebPage(payload(), {
    timeoutMs: 1,
    requestImpl: (_url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
    lookupImpl: publicLookup,
  });
  assert.equal(timeout.snapshotError, '网页加载超时');

  const oversized = await fetchWebPage(payload(), {
    maxBytes: 4,
    requestImpl: response('12345'),
    lookupImpl: publicLookup,
  });
  assert.match(oversized.snapshotError || '', /超过 4 字节限制/);
});

test('rejects private destinations and HTTPS downgrade redirects', async () => {
  const privateDestination = await fetchWebPage(payload('http://127.0.0.1/private'), {
    requestImpl: response('<p>must not fetch</p>'),
  });
  assert.match(privateDestination.snapshotError || '', /本地主机|非公网/);

  const downgrade = await fetchWebPage(payload(), {
    lookupImpl: publicLookup,
    requestImpl: response('', { status: 302, location: 'http://example.test/insecure' }),
  });
  assert.match(downgrade.snapshotError || '', /降级/);
});

test('rejects hexadecimal IPv4-mapped IPv6 private DNS answers', async () => {
  const result = await fetchWebPage(payload(), {
    lookupImpl: async () => [{ address: '::ffff:c0a8:0101', family: 6 as const }],
    requestImpl: response('<p>must not fetch</p>'),
  });
  assert.match(result.snapshotError || '', /非公网/);
});

test('rejects dotted IPv4-mapped IPv6 private DNS answers', async () => {
  const result = await fetchWebPage(payload(), {
    lookupImpl: async () => [{ address: '::ffff:192.168.1.1', family: 6 as const }],
    requestImpl: response('<p>must not fetch</p>'),
  });
  assert.match(result.snapshotError || '', /非公网/);
});

test('rejects expanded IPv4-mapped IPv6 and multicast DNS answers', async () => {
  const mapped = await fetchWebPage(payload(), {
    lookupImpl: async () => [{ address: '0:0:0:0:0:ffff:c0a8:0101', family: 6 as const }],
    requestImpl: response('<p>must not fetch</p>'),
  });
  assert.match(mapped.snapshotError || '', /非公网/);

  const multicast = await fetchWebPage(payload(), {
    lookupImpl: async () => [{ address: 'ff02::1', family: 6 as const }],
    requestImpl: response('<p>must not fetch</p>'),
  });
  assert.match(multicast.snapshotError || '', /非公网/);
});
