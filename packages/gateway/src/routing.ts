export type GatewayTarget = 'server' | 'client';

export function selectGatewayTarget(url: string, isProd: boolean): GatewayTarget {
  if (isProd) return 'server';
  if (
    url.startsWith('/api/')
    || url.startsWith('/sse/')
    || url === '/kits'
    || url.startsWith('/kits/')
  ) {
    return 'server';
  }
  return 'client';
}
