import { describe, expect, it } from 'vitest';
import { selectGatewayTarget } from '../src/routing';

describe('Gateway routing', () => {
  it.each(['/api/kits', '/api/session', '/sse/session-id', '/kits/mysql'])
  ('routes %s to Server in development', (url) => {
    expect(selectGatewayTarget(url, false)).toBe('server');
  });

  it.each(['/', '/src/index.ts', '/assets/index.js'])
  ('routes %s to Vite in development', (url) => {
    expect(selectGatewayTarget(url, false)).toBe('client');
  });

  it('routes every production request to Server', () => {
    expect(selectGatewayTarget('/', true)).toBe('server');
    expect(selectGatewayTarget('/assets/index.js', true)).toBe('server');
  });
});
