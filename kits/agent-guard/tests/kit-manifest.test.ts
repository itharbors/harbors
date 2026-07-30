import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const kitRoot = path.resolve(__dirname, '..');

describe('Agent Guard Kit manifest', () => {
  it('declares a native macOS guard with a lazy center and startup background', () => {
    const manifest = readJson(path.join(kitRoot, 'kit.json'));
    const pkg = readJson(path.join(kitRoot, 'package.json'));
    const layout = readJson(path.join(kitRoot, 'layout.json'));

    expect(manifest).toMatchObject({
      id: '@itharbors/kit-agent-guard',
      target: { platform: 'darwin', arch: 'arm64' },
      permissions: ['network', 'filesystem', 'process-control', 'application-startup'],
    });
    expect(pkg['ce-editor'].kit.startup.plugins).toEqual([
      '@itharbors/agent-guard-background',
    ]);
    expect(pkg['ce-editor'].kit.plugin).toEqual([
      '@itharbors/agent-guard-center',
    ]);
    expect(layout.activePanel).toBe('@itharbors/agent-guard-center.guard');
  });

  it('ships the exact versioned v1 guard thresholds without proxy dependencies', () => {
    const policy = readJson(path.join(kitRoot, 'resources/policy-v1.json'));
    const pkg = readJson(path.join(kitRoot, 'package.json'));

    expect(policy).toMatchObject({
      schemaVersion: 1,
      evaluationWindowSeconds: 60,
      consecutiveWindows: 3,
      trafficWindowMinutes: 10,
      dynamicWarning: {
        medianMultiplier: 5,
        madMultiplier: 6,
        minOutboundMiBPerMinute: 8,
        corroborators: { sessionsPerMinute: 6, tasksPerMinute: 8, connectionsPerMinute: 20 },
      },
      fixedWarning: { outboundMiB: 128, sessionsOrTasks: 20 },
      fixedTrip: { outboundMiB: 256, sessionsOrTasks: 30 },
      structuralTrip: {
        recursiveDepth: 4,
        recursiveTasks: 8,
        recursiveWindowSeconds: 120,
        burstTasks: 20,
        burstActiveTasks: 8,
        burstWindowSeconds: 60,
      },
    });
    expect(JSON.stringify(pkg)).not.toMatch(/proxy|sqlite|database/iu);
  });
});

function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
