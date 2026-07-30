import { describe, expect, it } from 'vitest';

import { DnsHistory, attributeConnection, digestRemoteAddress } from '../main/src/attribution.js';
import type { ConnectionCounter } from '../main/src/types.js';

describe('connection attribution', () => {
  it('confirms configured task traffic whose address is unique and within DNS TTL', () => {
    const dns = new DnsHistory();
    dns.update('super-relay.byted.org', ['203.0.113.10'], 10_000, 60_000);

    expect(attributeConnection({
      counter: connection(),
      processRole: 'task',
      configuration: {
        agent: 'claude', provider: 'custom', endpoint: 'https://super-relay.byted.org',
        hookExecutables: [],
      },
      salt: Buffer.from('local-salt'),
    }, dns, 20_000)).toMatchObject({
      displayHostname: 'super-relay.byted.org',
      confidence: 'confirmed',
      evidence: ['CONFIG_ENDPOINT', 'PROCESS_TASK', 'DNS_ADDRESS_MATCH'],
    });
  });

  it('downgrades shared or expired addresses and keeps stable salted digests', () => {
    const dns = new DnsHistory();
    dns.update('relay.example.test', ['203.0.113.10'], 10_000, 60_000);
    dns.update('telemetry.example.test', ['203.0.113.10'], 10_000, 60_000);
    const input = {
      counter: connection(),
      processRole: 'task' as const,
      configuration: {
        agent: 'codex' as const, provider: 'relay', endpoint: 'https://relay.example.test/v1',
        hookExecutables: [],
      },
      salt: Buffer.from('local-salt'),
    };

    expect(attributeConnection(input, dns, 20_000).confidence).toBe('probable');
    expect(attributeConnection(input, dns, 80_001).confidence).toBe('probable');
    expect(digestRemoteAddress('203.0.113.10:443', Buffer.from('local-salt')))
      .toMatch(/^[a-f0-9]{16}$/u);
    expect(digestRemoteAddress('203.0.113.10:443', Buffer.from('local-salt')))
      .toBe(digestRemoteAddress('203.0.113.10:443', Buffer.from('local-salt')));
  });
});

function connection(): ConnectionCounter {
  return {
    observedAt: 20_000, pid: 41, processStartTime: 1000, executableIdentity: 'id',
    localAddress: '127.0.0.1:5000',
    remoteAddress: '203.0.113.10:443', transport: 'tcp', state: 'ESTABLISHED',
    bytesIn: 20n, bytesOut: 40n,
  };
}
