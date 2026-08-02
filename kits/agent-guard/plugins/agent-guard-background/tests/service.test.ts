import { describe, expect, it, vi } from 'vitest';

import type { HistoryBackfillProgress, HistoryStorageStatus } from '@itharbors/agent-guard-contracts';

import { createAgentGuardService } from '../main/src/service.js';

describe('Agent Guard service', () => {
  it('starts once, projects a snapshot, routes commands, and restores before stopping', async () => {
    const collector = { start: vi.fn(), stop: vi.fn(), snapshot: () => ({ running: true, epoch: 1 }) };
    const target = {
      pid: 41, processStartTime: 1000, executableIdentity: 'id', processGroupId: 41, role: 'task' as const,
    };
    const controller = {
      pause: vi.fn(), resume: vi.fn(), terminateRecursive: vi.fn(), pausedTargets: () => [target],
    };
    const service = createAgentGuardService({
      collector,
      controller,
      initialPolicy: policy(),
      scheduleInterval: vi.fn(() => 1 as never),
      clearScheduledInterval: vi.fn(),
      flushMetrics: vi.fn(async () => undefined),
      evaluate: vi.fn(async () => undefined),
    });
    service.registerIncident('incident-1', target);

    await service.start();
    await service.start();
    expect(await service.getSnapshot()).toMatchObject({
      schemaVersion: 1, collector: { status: 'running', epoch: 1 },
    });
    await service.executeCommand({ type: 'resume', incidentId: 'incident-1' });
    expect(controller.resume).toHaveBeenCalledTimes(1);
    await service.dispose();
    await service.dispose();
    expect(collector.stop).toHaveBeenCalledTimes(1);
  });

  it('strictly validates commands and policy updates', async () => {
    const service = createAgentGuardService({
      collector: { start: vi.fn(), stop: vi.fn(), snapshot: () => ({ running: false, epoch: 0 }) },
      controller: { pause: vi.fn(), resume: vi.fn(), terminateRecursive: vi.fn(), pausedTargets: () => [] },
      initialPolicy: policy(), scheduleInterval: vi.fn(() => 1 as never),
      clearScheduledInterval: vi.fn(), flushMetrics: vi.fn(), evaluate: vi.fn(),
    });
    await expect(service.executeCommand({ type: 'resume', incidentId: '', prompt: 'secret' }))
      .rejects.toThrow(/unknown field|incidentId/iu);
    await expect(service.updatePolicy({ ...policy(), proxyPort: 8080 })).rejects.toThrow(/unknown field/iu);
  });

  it('reports learning state until the persisted learning period ends', async () => {
    let learning = true;
    const service = createAgentGuardService({
      collector: { start: vi.fn(), stop: vi.fn(), snapshot: () => ({ running: true, epoch: 1 }) },
      controller: { pause: vi.fn(), resume: vi.fn(), terminateRecursive: vi.fn(), pausedTargets: () => [] },
      initialPolicy: policy(), scheduleInterval: vi.fn(() => 1 as never),
      clearScheduledInterval: vi.fn(), flushMetrics: vi.fn(), evaluate: vi.fn(),
      isLearning: () => learning,
    });
    expect((await service.getSnapshot()).state).toBe('learning');
    learning = false;
    expect((await service.getSnapshot()).state).toBe('normal');
  });

  it('strictly routes history queries, settings, status, and scoped clearing', async () => {
    let lastQuery: unknown;
    let localSessionBackfill = true;
    let cleared = false;
    const service = createAgentGuardService({
      collector: { start: vi.fn(), stop: vi.fn(), snapshot: () => ({ running: true, epoch: 1 }) },
      controller: { pause: vi.fn(), resume: vi.fn(), terminateRecursive: vi.fn(), pausedTargets: () => [] },
      initialPolicy: policy(), scheduleInterval: vi.fn(() => 1 as never),
      clearScheduledInterval: vi.fn(), flushMetrics: vi.fn(), evaluate: vi.fn(),
      history: {
        async query(input: unknown) { lastQuery = input; return { accepted: input }; },
        async status() { return storageStatus({ localSessionBackfill, storageBytes: cleared ? 0 : 10 }); },
        async updateSettings(input: { localSessionBackfill: boolean }) {
          localSessionBackfill = input.localSessionBackfill;
          return storageStatus({ localSessionBackfill });
        },
        async clearHistory() { cleared = true; },
      },
      backfill: fakeBackfill(),
    });
    const query = {
      from: 1_000, to: 61_000, domain: 'network', agents: ['claude'],
      hostnames: ['relay.example.test'], preferredBucket: 'minute',
    };

    await service.getTrafficHistory(query);
    expect(lastQuery).toEqual(query);
    const disabled = await service.updateHistorySettings({ localSessionBackfill: false });
    expect(disabled.settings.localSessionBackfill).toBe(false);
    await service.clearHistory({ confirmation: 'clear-history' });
    const status = await service.getHistoryStatus();
    expect(status.settings.localSessionBackfill).toBe(false);
    expect(status.storageBytes).toBe(0);
    expect(status.backfill.state).toBe('disabled');
    expect(status.backfill.message).toBe('disabled');
    await expect(service.getTrafficHistory({ ...query, prompt: 'secret' })).rejects.toThrow(/unknown field/iu);
    await expect(service.clearHistory({ confirmation: 'yes' })).rejects.toThrow(/clear-history/iu);
  });

  it('composes storage facts with live backfill progress without mutating either input', async () => {
    const storage = storageStatus({ localSessionBackfill: true, storageBytes: 42 });
    const live = scanningProgress();
    const backfill = fakeBackfill(live);
    const service = createAgentGuardService({
      ...baseOptions(),
      history: {
        async query() { return {}; },
        async status() { return storage; },
        async updateSettings() { return storage; },
        async clearHistory() { /* unused */ },
      },
      backfill,
    });

    const status = await service.getHistoryStatus();
    expect(status.storageBytes).toBe(42);
    expect(status.backfill.state).toBe('scanning');
    expect(status.backfill.filesScanned).toBe(3);
    // Neither the storage object nor the live progress object was mutated during composition.
    expect(storage).toEqual(storageStatus({ localSessionBackfill: true, storageBytes: 42 }));
    expect((storage as Record<string, unknown>).backfill).toBeUndefined();
    expect(live).toEqual(scanningProgress());
    expect(status.backfill).not.toBe(live);
  });

  it('persists settings before requesting work when enabling local backfill', async () => {
    const order: string[] = [];
    const backfill = fakeBackfill();
    backfill.scheduler.trigger = vi.fn(() => { order.push('trigger'); });
    const service = createAgentGuardService({
      ...baseOptions(),
      history: {
        async query() { return {}; },
        async status() { return storageStatus({ localSessionBackfill: true }); },
        async updateSettings(input: { localSessionBackfill: boolean }) {
          order.push(`persist:${input.localSessionBackfill}`);
          return storageStatus({ localSessionBackfill: input.localSessionBackfill });
        },
        async clearHistory() { /* unused */ },
      },
      backfill,
    });

    await service.updateHistorySettings({ localSessionBackfill: true });
    expect(order).toEqual(['persist:true', 'trigger']);
  });

  it('does not request new work when disabling local backfill', async () => {
    const live = scanningProgress();
    const backfill = fakeBackfill(live);
    backfill.scheduler.trigger = vi.fn();
    backfill.backfiller.requestRun = vi.fn(async () => ({}));
    const service = createAgentGuardService({
      ...baseOptions(),
      history: {
        async query() { return {}; },
        async status() { return storageStatus({ localSessionBackfill: false }); },
        async updateSettings() { return storageStatus({ localSessionBackfill: false }); },
        async clearHistory() { /* unused */ },
      },
      backfill,
    });

    const disabled = await service.updateHistorySettings({ localSessionBackfill: false });
    // Persisted disabling is authoritative even over a stale live 'scanning' progress: the returned
    // status must report 'disabled' with a 'disabled' message and no queued remaining work.
    expect(disabled.settings.localSessionBackfill).toBe(false);
    expect(disabled.backfill.state).toBe('disabled');
    expect(disabled.backfill.message).toBe('disabled');
    expect(disabled.backfill.remainingFiles).toBeNull();
    // A subsequent status read reports the same disabled semantics.
    const status = await service.getHistoryStatus();
    expect(status.backfill.state).toBe('disabled');
    expect(status.backfill.message).toBe('disabled');
    expect(status.backfill.remainingFiles).toBeNull();
    // No work was triggered and the live progress object was never mutated during composition.
    expect(backfill.scheduler.trigger).not.toHaveBeenCalled();
    expect(backfill.backfiller.requestRun).not.toHaveBeenCalled();
    expect(live).toEqual(scanningProgress());
  });

  it('runs a manual backfill only for the exact { reason: "manual" } shape', async () => {
    const backfill = fakeBackfill(completeProgress());
    const requestRun = vi.fn(async () => ({}));
    backfill.backfiller.requestRun = requestRun;
    const service = createAgentGuardService({
      ...baseOptions(),
      history: {
        async query() { return {}; },
        async status() { return storageStatus({ localSessionBackfill: true }); },
        async updateSettings() { return storageStatus({ localSessionBackfill: true }); },
        async clearHistory() { /* unused */ },
      },
      backfill,
    });

    const status = await service.runHistoryBackfill({ reason: 'manual' });
    expect(requestRun).toHaveBeenCalledTimes(1);
    expect(status.schemaVersion).toBe(1);
    expect(status.backfill.state).toBe('complete');

    await expect(service.runHistoryBackfill(null)).rejects.toThrow(/object/iu);
    await expect(service.runHistoryBackfill('manual')).rejects.toThrow(/object/iu);
    await expect(service.runHistoryBackfill({})).rejects.toThrow(/reason/iu);
    await expect(service.runHistoryBackfill({ reason: 'manual', extra: 1 })).rejects.toThrow(/unknown field/iu);
    await expect(service.runHistoryBackfill({ reason: 'scheduled' })).rejects.toThrow(/manual/iu);
    // Rejected shapes never request work; only the first valid call did.
    expect(requestRun).toHaveBeenCalledTimes(1);
  });

  it('starts and disposes the scheduler and backfiller idempotently', async () => {
    const backfill = fakeBackfill();
    backfill.scheduler.start = vi.fn();
    backfill.scheduler.dispose = vi.fn();
    backfill.backfiller.dispose = vi.fn();
    const service = createAgentGuardService({ ...baseOptions(), backfill });

    await service.start();
    await service.start();
    expect(backfill.scheduler.start).toHaveBeenCalledTimes(1);
    await service.dispose();
    await service.dispose();
    expect(backfill.scheduler.dispose).toHaveBeenCalledTimes(1);
    expect(backfill.backfiller.dispose).toHaveBeenCalledTimes(1);
  });
});

function baseOptions() {
  return {
    collector: { start: vi.fn(), stop: vi.fn(), snapshot: () => ({ running: true, epoch: 1 }) },
    controller: { pause: vi.fn(), resume: vi.fn(), terminateRecursive: vi.fn(), pausedTargets: () => [] },
    initialPolicy: policy(),
    scheduleInterval: vi.fn(() => 1 as never),
    clearScheduledInterval: vi.fn(),
    flushMetrics: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => undefined),
  };
}

function fakeBackfill(live: HistoryBackfillProgress = idleProgress()) {
  return {
    backfiller: {
      requestRun: vi.fn(async () => ({})),
      status: () => live,
      dispose: vi.fn(),
    },
    scheduler: { start: vi.fn(), trigger: vi.fn(), dispose: vi.fn() },
  };
}

function storageStatus(overrides: Partial<HistoryStorageStatus> & { localSessionBackfill?: boolean } = {}): HistoryStorageStatus {
  const { localSessionBackfill = true, ...rest } = overrides;
  return {
    schemaVersion: 1,
    persistent: false,
    storageBytes: 0,
    earliestAt: null,
    latestAt: null,
    generation: 0,
    lastCompactedAt: null,
    lastBackfilledAt: null,
    settings: { localSessionBackfill },
    warnings: [],
    ...rest,
  };
}

function idleProgress(): HistoryBackfillProgress {
  return {
    state: 'idle', runId: 0, startedAt: null, updatedAt: null, completedAt: null,
    filesDiscovered: 0, filesEligible: 0, filesScanned: 0, filesSkipped: 0, bytesRead: 0,
    eventsWritten: 0, unsupportedRecords: 0, errors: 0, remainingFiles: null,
    lastSuccessfulEventAt: null, message: 'idle',
    agents: [zeroAgent('claude'), zeroAgent('codex')],
  };
}

function scanningProgress(): HistoryBackfillProgress {
  return {
    state: 'scanning', runId: 4, startedAt: 1_700_000_000_000, updatedAt: 1_700_000_000_500,
    completedAt: null, filesDiscovered: 8, filesEligible: 5, filesScanned: 3, filesSkipped: 3,
    bytesRead: 4096, eventsWritten: 7, unsupportedRecords: 0, errors: 0, remainingFiles: 2,
    lastSuccessfulEventAt: 1_699_999_999_000, message: 'scanning',
    agents: [zeroAgent('claude'), zeroAgent('codex')],
  };
}

function completeProgress(): HistoryBackfillProgress {
  return { ...idleProgress(), state: 'complete', message: 'complete' };
}

function zeroAgent(agent: 'claude' | 'codex') {
  return { agent, filesDiscovered: 0, filesEligible: 0, filesScanned: 0, filesSkipped: 0, eventsWritten: 0, errors: 0 };
}

function policy() {
  return {
    schemaVersion: 1 as const, evaluationWindowSeconds: 60, consecutiveWindows: 3,
    trafficWindowMinutes: 10, learningHours: 24,
    dynamicWarning: {
      medianMultiplier: 5, madMultiplier: 6, minOutboundMiBPerMinute: 8,
      corroborators: { sessionsPerMinute: 6, tasksPerMinute: 8, connectionsPerMinute: 20 },
    },
    fixedWarning: { outboundMiB: 128, sessionsOrTasks: 20 },
    fixedTrip: { outboundMiB: 256, sessionsOrTasks: 30, minimumConfidence: 'confirmed' as const },
    structuralTrip: {
      recursiveDepth: 4, recursiveTasks: 8, recursiveWindowSeconds: 120,
      burstTasks: 20, burstActiveTasks: 8, burstWindowSeconds: 60,
    },
  };
}
