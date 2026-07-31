import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { normalizePolicy } from '@itharbors/agent-guard-contracts';
import { PolicyEngine, type PolicySample } from '../main/src/policy.js';

const policy = normalizePolicy(JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../../../resources/policy-v1.json'), 'utf8',
)));

describe('policy v1', () => {
  it('warns on a corroborated dynamic spike during learning but never controls it', () => {
    const engine = new PolicyEngine(policy);
    expect(engine.evaluate(sample({
      learning: true,
      bytesOutPerMinute: 9 * MIB,
      sessionsPerMinute: 6,
      baseline: { median: MIB, mad: MIB / 4, samples: 120 },
    }))).toMatchObject({ state: 'warning', level: 'warning', control: null, ruleId: 'dynamic-warning' });
  });

  it('keeps a single large byte spike warning-only', () => {
    const engine = new PolicyEngine(policy);
    expect(engine.evaluate(sample({ bytesOutTenMinutes: 300 * MIB })))
      .toMatchObject({ state: 'warning', control: null, ruleId: 'uncorroborated-byte-spike' });
  });

  it('pauses confirmed complete fixed multi-signal traffic only after three windows', () => {
    const engine = new PolicyEngine(policy);
    const input = sample({
      bytesOutTenMinutes: 256 * MIB,
      sessionsTenMinutes: 30,
      confidence: 'confirmed',
      complete: true,
    });
    expect(engine.evaluate(input).control).toBeNull();
    expect(engine.evaluate({ ...input, at: input.at + 60_000 }).control).toBeNull();
    expect(engine.evaluate({ ...input, at: input.at + 120_000 })).toMatchObject({
      state: 'tripped', control: { action: 'pause' }, ruleId: 'fixed-traffic-trip',
    });
  });

  it('terminates confirmed recursive task subtrees immediately during learning', () => {
    const engine = new PolicyEngine(policy);
    expect(engine.evaluate(sample({
      learning: true,
      processTree: {
        sameExecutableDepth: 4, maxWidth: 2, newTaskProcesses: 8,
        activeTaskProcesses: 8, bounded: false,
      },
      recursiveTasksInWindow: 8,
    }))).toMatchObject({
      state: 'tripped', control: { action: 'terminate-recursive-subtree' },
      ruleId: 'structural-recursion-trip',
    });
  });

  it('downgrades structurally suspicious but incomplete trees to warning-only', () => {
    const engine = new PolicyEngine(policy);
    expect(engine.evaluate(sample({
      confidence: 'probable',
      complete: false,
      recursiveTasksInWindow: 8,
      processTree: {
        sameExecutableDepth: 4, maxWidth: 2, newTaskProcesses: 8,
        activeTaskProcesses: 8, bounded: true,
      },
    }))).toMatchObject({ state: 'warning', control: null });
  });
});

const MIB = 1024 * 1024;

function sample(overrides: Partial<PolicySample> = {}): PolicySample {
  return {
    at: 1_754_000_000_000,
    agent: 'claude', endpoint: 'relay.example.test', learning: false,
    complete: true, confidence: 'confirmed', bytesOutPerMinute: 0,
    bytesOutTenMinutes: 0, sessionsPerMinute: 0, tasksPerMinute: 0,
    connectionsPerMinute: 0, sessionsTenMinutes: 0, tasksTenMinutes: 0,
    recursiveTasksInWindow: 0,
    baseline: { median: MIB, mad: MIB / 4, samples: 120 },
    processTree: {
      sameExecutableDepth: 1, maxWidth: 1, newTaskProcesses: 0,
      activeTaskProcesses: 0, bounded: false,
    },
    ...overrides,
  };
}
