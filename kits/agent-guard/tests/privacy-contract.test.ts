import { describe, expect, it } from 'vitest';

import {
  normalizeCommand,
  normalizePolicy,
  normalizeSnapshot,
} from '@itharbors/agent-guard-contracts';

const snapshot = {
  schemaVersion: 1,
  observedAt: 1_754_000_000_000,
  state: 'normal',
  collector: {
    status: 'running',
    epoch: 3,
    lastObservedAt: 1_754_000_000_000,
    incomplete: false,
  },
  endpoints: [{
    agent: 'claude',
    provider: 'custom',
    hostname: 'relay.example.test',
    confidence: 'confirmed',
    bytesIn: 1024,
    bytesOut: 2048,
    bytesInPerMinute: 512,
    bytesOutPerMinute: 1024,
    connections: 2,
    activeTasks: 1,
  }],
  incidents: [],
};

describe('Agent Guard public contracts', () => {
  it('accepts metadata-only snapshots and rejects unknown sensitive fields', () => {
    expect(normalizeSnapshot(snapshot)).toEqual(snapshot);
    for (const sensitiveField of ['prompt', 'response', 'authorization', 'cookie', 'apiKey', 'argv', 'env']) {
      expect(() => normalizeSnapshot({ ...snapshot, [sensitiveField]: 'secret' }))
        .toThrow(/unknown field/iu);
    }
  });

  it('strictly normalizes user commands', () => {
    expect(normalizeCommand({ type: 'resume', incidentId: 'incident-1' })).toEqual({
      type: 'resume', incidentId: 'incident-1',
    });
    expect(normalizeCommand({
      type: 'ignore', incidentId: 'incident-1', durationMinutes: 30,
    })).toEqual({ type: 'ignore', incidentId: 'incident-1', durationMinutes: 30 });
    expect(() => normalizeCommand({
      type: 'ignore', incidentId: 'incident-1', durationMinutes: 0,
    })).toThrow(/durationMinutes/iu);
  });

  it('normalizes the bundled policy with no implicit fields', () => {
    const policy = JSON.parse(`{
      "schemaVersion": 1,
      "evaluationWindowSeconds": 60,
      "consecutiveWindows": 3,
      "trafficWindowMinutes": 10,
      "learningHours": 24,
      "dynamicWarning": {
        "medianMultiplier": 5,
        "madMultiplier": 6,
        "minOutboundMiBPerMinute": 8,
        "corroborators": { "sessionsPerMinute": 6, "tasksPerMinute": 8, "connectionsPerMinute": 20 }
      },
      "fixedWarning": { "outboundMiB": 128, "sessionsOrTasks": 20 },
      "fixedTrip": { "outboundMiB": 256, "sessionsOrTasks": 30, "minimumConfidence": "confirmed" },
      "structuralTrip": {
        "recursiveDepth": 4,
        "recursiveTasks": 8,
        "recursiveWindowSeconds": 120,
        "burstTasks": 20,
        "burstActiveTasks": 8,
        "burstWindowSeconds": 60
      }
    }`);

    expect(normalizePolicy(policy)).toEqual(policy);
    expect(() => normalizePolicy({ ...policy, proxyPort: 8080 })).toThrow(/unknown field/iu);
  });
});
