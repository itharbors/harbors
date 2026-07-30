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
