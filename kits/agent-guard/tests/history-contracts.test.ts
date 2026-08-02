import { describe, expect, it } from 'vitest';

import {
  normalizeHistoryStatus,
  type HistoryBackfillProgress,
  type HistoryBackfillState,
  type HistoryStatus,
} from '@itharbors/agent-guard-contracts';

const STATES: HistoryBackfillState[] = [
  'disabled', 'idle', 'discovering', 'scanning', 'partial', 'complete', 'error',
];

describe('Agent Guard history status backfill contract', () => {
  it('accepts a fully populated scanning progress with Claude and Codex breakdowns', () => {
    const status = normalizeHistoryStatus(baseStatus());

    expect(status.backfill.state).toBe('scanning');
    expect(status.backfill.runId).toBe(4);
    expect(status.backfill.remainingFiles).toBe(5);
    expect(status.backfill.completedAt).toBeNull();
    expect(status.backfill.message).toBe('scanning');
    expect(status.backfill.agents.map((entry) => entry.agent)).toEqual(['claude', 'codex']);
    expect(status.backfill.agents[0]).toEqual({
      agent: 'claude', filesDiscovered: 20, filesEligible: 6, filesScanned: 2,
      filesSkipped: 14, eventsWritten: 5, errors: 0,
    });
  });

  it('accepts every backfill state', () => {
    for (const state of STATES) {
      const status = normalizeHistoryStatus(baseStatus({ state }));
      expect(status.backfill.state).toBe(state);
    }
  });

  it('accepts a null remainingFiles before discovery completes', () => {
    const status = normalizeHistoryStatus(baseStatus({ remainingFiles: null }));
    expect(status.backfill.remainingFiles).toBeNull();
  });

  it('accepts nullable timestamps and last successful event time', () => {
    const status = normalizeHistoryStatus(baseStatus({
      startedAt: null, updatedAt: null, completedAt: null, lastSuccessfulEventAt: null,
    }));
    expect(status.backfill.startedAt).toBeNull();
    expect(status.backfill.updatedAt).toBeNull();
    expect(status.backfill.lastSuccessfulEventAt).toBeNull();
  });

  it('rejects an unknown backfill state', () => {
    expect(() => normalizeHistoryStatus(baseStatus({ state: 'paused' as never })))
      .toThrow(/state/iu);
  });

  it('rejects unknown backfill fields', () => {
    const value = baseStatus();
    (value.backfill as Record<string, unknown>).rawPath = '/home/user/.claude/session.jsonl';
    expect(() => normalizeHistoryStatus(value)).toThrow(/unknown field/iu);
  });

  it('rejects unknown per-Agent fields', () => {
    const value = baseStatus();
    (value.backfill.agents[0] as Record<string, unknown>).filename = 'session.jsonl';
    expect(() => normalizeHistoryStatus(value)).toThrow(/unknown field/iu);
  });

  it('rejects negative counters', () => {
    expect(() => normalizeHistoryStatus(baseStatus({ eventsWritten: -1 })))
      .toThrow(/eventsWritten/iu);
    const withAgent = baseStatus();
    withAgent.backfill.agents[1].errors = -3;
    expect(() => normalizeHistoryStatus(withAgent)).toThrow(/errors/iu);
  });

  it('rejects a message longer than 128 characters', () => {
    expect(() => normalizeHistoryStatus(baseStatus({ message: 'x'.repeat(129) })))
      .toThrow(/message/iu);
  });

  it('rejects a missing Codex Agent entry', () => {
    const value = baseStatus();
    value.backfill.agents = [value.backfill.agents[0]];
    expect(() => normalizeHistoryStatus(value)).toThrow(/agents/iu);
  });

  it('rejects Agent entries out of the fixed Claude then Codex order', () => {
    const value = baseStatus();
    value.backfill.agents = [value.backfill.agents[1], value.backfill.agents[0]];
    expect(() => normalizeHistoryStatus(value)).toThrow(/agents/iu);
  });

  it('rejects a status missing the backfill object', () => {
    const value = baseStatus() as Record<string, unknown>;
    delete value.backfill;
    expect(() => normalizeHistoryStatus(value)).toThrow(/backfill/iu);
  });
});

type MutableStatus = Omit<HistoryStatus, 'backfill'> & {
  backfill: Omit<HistoryBackfillProgress, 'agents'> & {
    agents: HistoryBackfillProgress['agents'][number][];
  };
};

function baseStatus(overrides: Partial<HistoryBackfillProgress> = {}): MutableStatus {
  return {
    schemaVersion: 1,
    persistent: true,
    storageBytes: 4096,
    earliestAt: 1_699_999_000_000,
    latestAt: 1_700_000_000_000,
    generation: 2,
    lastCompactedAt: null,
    lastBackfilledAt: 1_700_000_000_000,
    settings: { localSessionBackfill: true },
    warnings: [],
    backfill: {
      state: 'scanning',
      runId: 4,
      startedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_500,
      completedAt: null,
      filesDiscovered: 24,
      filesEligible: 8,
      filesScanned: 3,
      filesSkipped: 16,
      bytesRead: 4096,
      eventsWritten: 7,
      unsupportedRecords: 2,
      errors: 0,
      remainingFiles: 5,
      lastSuccessfulEventAt: 1_699_999_999_000,
      message: 'scanning',
      agents: [
        { agent: 'claude', filesDiscovered: 20, filesEligible: 6, filesScanned: 2, filesSkipped: 14, eventsWritten: 5, errors: 0 },
        { agent: 'codex', filesDiscovered: 4, filesEligible: 2, filesScanned: 1, filesSkipped: 2, eventsWritten: 2, errors: 0 },
      ],
      ...overrides,
    },
  };
}
