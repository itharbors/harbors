import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { normalizePolicy } from '@itharbors/agent-guard-contracts';
import { PolicyEngine, type PolicySample } from '../plugins/agent-guard-background/main/src/policy.js';

const policy = normalizePolicy(JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../resources/policy-v1.json'), 'utf8',
)));

describe('incident replay', () => {
  it('leaves normal concurrent agents alone and trips the recorded recursive SessionEnd shape', () => {
    const engine = new PolicyEngine(policy);
    const normal = base({ tasksPerMinute: 4, connectionsPerMinute: 8, bytesOutPerMinute: 4 * MIB });
    expect(engine.evaluate(normal).state).toBe('normal');

    const runaway = base({
      at: normal.at + 60_000,
      learning: true,
      recursiveTasksInWindow: 8,
      processTree: {
        sameExecutableDepth: 4, maxWidth: 3, newTaskProcesses: 8,
        activeTaskProcesses: 8, bounded: false,
      },
    });
    const result = engine.evaluate(runaway);
    expect(result).toMatchObject({ state: 'tripped', ruleId: 'structural-recursion-trip' });
    expect(result.control?.action).toBe('terminate-recursive-subtree');
    expect(result.incidentId).toBe(new PolicyEngine(policy).evaluate(runaway).incidentId);
  });
});

const MIB = 1024 * 1024;
function base(overrides: Partial<PolicySample>): PolicySample {
  return {
    at: 1_754_000_000_000, agent: 'claude', endpoint: 'relay.example.test', learning: false,
    complete: true, confidence: 'confirmed', bytesOutPerMinute: 0, bytesOutTenMinutes: 0,
    sessionsPerMinute: 0, tasksPerMinute: 0, connectionsPerMinute: 0,
    sessionsTenMinutes: 0, tasksTenMinutes: 0, recursiveTasksInWindow: 0,
    baseline: { median: 2 * MIB, mad: MIB, samples: 1440 },
    processTree: {
      sameExecutableDepth: 1, maxWidth: 1, newTaskProcesses: 0,
      activeTaskProcesses: 0, bounded: false,
    },
    ...overrides,
  };
}
