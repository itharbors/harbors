import { describe, expect, it } from 'vitest';

import { aggregateMetricWindow } from '../main/src/aggregator.js';
import type { AttributedConnection } from '../main/src/attribution.js';

describe('metric window aggregation', () => {
  it('subtracts cumulative counters instead of sampling individual requests', () => {
    const first = attributed(20n, 20n, 1_000);
    const second = attributed(60n, 80n, 3_000);

    expect(aggregateMetricWindow([
      { epoch: 1, connection: first },
      { epoch: 1, connection: second },
    ])).toMatchObject({ complete: true, bytesOut: 60n, bytesIn: 40n, connections: 1 });
  });

  it('keeps incomplete measurements visible but ineligible for control', () => {
    const first = attributed(20n, 40n, 1_000);
    const rollback = attributed(10n, 5n, 3_000);
    expect(aggregateMetricWindow([
      { epoch: 1, connection: first },
      { epoch: 2, connection: rollback },
    ])).toMatchObject({ complete: false, controlEligible: false });
  });
});

function attributed(bytesIn: bigint, bytesOut: bigint, observedAt: number): AttributedConnection {
  return {
    agent: 'claude', provider: 'custom', displayHostname: 'relay.example.test',
    confidence: 'confirmed', evidence: ['CONFIG_ENDPOINT', 'PROCESS_TASK', 'DNS_ADDRESS_MATCH'],
    remoteAddress: '203.0.113.10:443', remoteDigest: '0123456789abcdef', processRole: 'task',
    counter: {
      observedAt, pid: 41, processStartTime: 1000, executableIdentity: 'id',
      remoteAddress: '203.0.113.10:443', transport: 'tcp', state: 'ESTABLISHED', bytesIn, bytesOut,
    },
  };
}
