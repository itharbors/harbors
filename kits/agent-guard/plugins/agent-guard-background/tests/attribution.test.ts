import { describe, expect, it } from 'vitest';

import {
  DnsHistory,
  attributeConnection,
  attributeConnectionFromConfigurations,
  digestRemoteAddress,
} from '../main/src/attribution.js';
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
      evidence: ['CONFIG_ENDPOINT', 'PROCESS_AGENT', 'PROCESS_TASK', 'DNS_ADDRESS_MATCH'],
    });
  });

  it('marks configured host traffic probable without making it a control-grade task', () => {
    const dns = new DnsHistory();
    dns.update('relay.example.test', ['203.0.113.10'], 10_000, 60_000);
    expect(attributeConnection({
      counter: connection(),
      processRole: 'host',
      configuration: {
        agent: 'codex', provider: 'relay', endpoint: 'https://relay.example.test/v1',
        hookExecutables: [],
      },
      salt: Buffer.from('local-salt'),
    }, dns, 20_000)).toMatchObject({
      confidence: 'probable',
      evidence: ['CONFIG_ENDPOINT', 'PROCESS_AGENT', 'DNS_ADDRESS_MATCH'],
      processRole: 'host',
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

  it('selects a unique configured source from multiple client endpoints', () => {
    const dns = new DnsHistory();
    dns.update('api.openai.com', ['203.0.113.20'], 10_000, 60_000);
    dns.update('relay.example.test', ['203.0.113.10'], 10_000, 60_000);

    expect(attributeConnectionFromConfigurations({
      counter: connection(), processRole: 'task', agent: 'codex', salt: Buffer.from('local-salt'),
      configurations: [
        configuration('codex', 'openai', 'https://api.openai.com/v1'),
        configuration('codex', 'relay', 'https://relay.example.test/v1'),
      ],
    }, dns, 20_000)).toMatchObject({
      provider: 'relay', displayHostname: 'relay.example.test', confidence: 'confirmed',
    });
  });

  it('does not apply a client default to an unmatched or ambiguous remote address', () => {
    const configurations = [
      configuration('claude', 'custom', 'https://relay.example.test'),
      configuration('claude', 'anthropic', 'https://api.anthropic.com'),
    ];
    const unmatched = new DnsHistory();
    unmatched.update('relay.example.test', ['203.0.113.20'], 10_000, 60_000);
    const unknown = attributeConnectionFromConfigurations({
      counter: connection(), processRole: 'task', agent: 'claude', configurations,
      salt: Buffer.from('local-salt'),
    }, unmatched, 20_000);
    expect(unknown).toMatchObject({
      provider: 'unknown', displayHostname: 'unknown', confidence: 'unknown',
      evidence: ['PROCESS_AGENT', 'ENDPOINT_UNRESOLVED', 'PROCESS_TASK'],
    });

    const shared = new DnsHistory();
    shared.update('relay.example.test', ['203.0.113.10'], 10_000, 60_000);
    shared.update('api.anthropic.com', ['203.0.113.10'], 10_000, 60_000);
    expect(attributeConnectionFromConfigurations({
      counter: connection(), processRole: 'task', agent: 'claude', configurations,
      salt: Buffer.from('local-salt'),
    }, shared, 20_000)).toMatchObject({
      provider: 'unknown', displayHostname: 'unknown', confidence: 'unknown',
      evidence: ['PROCESS_AGENT', 'ENDPOINT_UNRESOLVED', 'PROCESS_TASK', 'SHARED_ADDRESS'],
    });
  });
});

function configuration(
  agent: 'claude' | 'codex', provider: string, endpoint: string,
) {
  return { agent, provider, endpoint, hookExecutables: [] };
}

function connection(): ConnectionCounter {
  return {
    observedAt: 20_000, pid: 41, processStartTime: 1000, executableIdentity: 'id',
    localAddress: '127.0.0.1:5000',
    remoteAddress: '203.0.113.10:443', transport: 'tcp', state: 'ESTABLISHED',
    bytesIn: 20n, bytesOut: 40n,
  };
}
