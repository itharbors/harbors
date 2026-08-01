import { describe, expect, it, vi } from 'vitest';

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
        async status() { return { localSessionBackfill, cleared }; },
        async updateSettings(input: { localSessionBackfill: boolean }) {
          localSessionBackfill = input.localSessionBackfill;
          return { localSessionBackfill, cleared };
        },
        async clearHistory() { cleared = true; },
      },
    });
    const query = {
      from: 1_000, to: 61_000, domain: 'network', agents: ['claude'],
      hostnames: ['relay.example.test'], preferredBucket: 'minute',
    };

    await service.getTrafficHistory(query);
    expect(lastQuery).toEqual(query);
    expect(await service.updateHistorySettings({ localSessionBackfill: false })).toEqual({
      localSessionBackfill: false, cleared: false,
    });
    await service.clearHistory({ confirmation: 'clear-history' });
    expect(await service.getHistoryStatus()).toEqual({ localSessionBackfill: false, cleared: true });
    await expect(service.getTrafficHistory({ ...query, prompt: 'secret' })).rejects.toThrow(/unknown field/iu);
    await expect(service.clearHistory({ confirmation: 'yes' })).rejects.toThrow(/clear-history/iu);
  });
});

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
