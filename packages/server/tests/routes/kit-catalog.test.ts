import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createKitCatalogRouter } from '../../src/routes/kit-catalog';

const catalog = Promise.resolve([
  {
    id: 'mysql',
    name: '@itharbors/kit-mysql',
    label: 'MySQL',
    directory: '/private/repository/kits/mysql',
  },
]);

describe('Kit catalog routes', () => {
  it('returns a sanitized public catalog without local directories', async () => {
    const response = mockResponse();
    const router = createKitCatalogRouter('multi', catalog);

    await router(mockRequest('GET', '/api/kits'), response.res);

    expect(response.status()).toBe(200);
    expect(response.header('content-type')).toBe('application/json; charset=utf-8');
    expect(JSON.parse(response.body())).toEqual({
      mode: 'multi',
      kits: [{ id: 'mysql', name: '@itharbors/kit-mysql', label: 'MySQL' }],
    });
    expect(response.body()).not.toContain('/private/repository');
  });

  it('redirects a stable Kit id to the existing package-name entry path', async () => {
    const response = mockResponse();
    const router = createKitCatalogRouter('multi', catalog);

    await router(mockRequest('GET', '/kits/mysql'), response.res);

    expect(response.status()).toBe(302);
    expect(response.header('location')).toBe('/?kit=%40itharbors%2Fkit-mysql');
    expect(response.body()).toBe('');
  });

  it('rejects unknown Kit ids without treating them as filesystem paths', async () => {
    const router = createKitCatalogRouter('multi', catalog);

    await expect(router(mockRequest('GET', '/kits/..%2Fsecret'), mockResponse().res))
      .rejects.toMatchObject({ status: 404, code: 'KIT_NOT_FOUND' });
  });

  it('allows only GET requests', async () => {
    const router = createKitCatalogRouter('multi', catalog);

    await expect(router(mockRequest('POST', '/api/kits'), mockResponse().res))
      .rejects.toMatchObject({ status: 405, code: 'METHOD_NOT_ALLOWED' });
  });
});

function mockRequest(method: string, url: string): IncomingMessage {
  return { method, url, headers: {} } as IncomingMessage;
}

function mockResponse(): {
  res: ServerResponse;
  status: () => number;
  body: () => string;
  header: (name: string) => string | undefined;
} {
  const chunks: Buffer[] = [];
  const headers = new Map<string, string>();
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    end(chunk?: string | Buffer) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
  } as unknown as ServerResponse;
  return {
    res,
    status: () => res.statusCode,
    body: () => Buffer.concat(chunks).toString(),
    header: (name) => headers.get(name.toLowerCase()),
  };
}
