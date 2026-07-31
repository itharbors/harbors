import { createHash } from 'node:crypto';

import type {
  AgentId,
  AttributionConfidence,
  GuardState,
  PolicyV1,
} from '@itharbors/agent-guard-contracts';
import type { BaselineSnapshot } from './baseline.js';
import type { ProcessTreeMetrics } from './types.js';

const MIB = 1024 * 1024;

export interface PolicySample {
  at: number;
  agent: AgentId;
  endpoint: string;
  learning: boolean;
  complete: boolean;
  confidence: AttributionConfidence;
  bytesOutPerMinute: number;
  bytesOutTenMinutes: number;
  sessionsPerMinute: number;
  tasksPerMinute: number;
  connectionsPerMinute: number;
  sessionsTenMinutes: number;
  tasksTenMinutes: number;
  recursiveTasksInWindow: number;
  baseline: BaselineSnapshot;
  processTree: ProcessTreeMetrics;
}

export interface PolicyEvidence {
  code: string;
  measured: number;
  threshold: number;
  windowSeconds: number;
  confidence: AttributionConfidence;
  complete: boolean;
  policyVersion: 1;
}

export interface PolicyResult {
  state: GuardState;
  level: 'normal' | 'warning' | 'tripped';
  ruleId: string | null;
  incidentId: string | null;
  evidence: PolicyEvidence[];
  control: null | { action: 'pause' | 'terminate-recursive-subtree' };
}

interface SequenceState {
  count: number;
  firstAt: number;
}

export class PolicyEngine {
  #sequences = new Map<string, SequenceState>();

  constructor(readonly policy: PolicyV1) {}

  evaluate(sample: PolicySample): PolicyResult {
    const structural = this.#structural(sample);
    if (structural) return structural;

    const fixedTripCorroborated = sample.bytesOutTenMinutes >= this.policy.fixedTrip.outboundMiB * MIB
      && Math.max(sample.sessionsTenMinutes, sample.tasksTenMinutes) >= this.policy.fixedTrip.sessionsOrTasks;
    const sequenceKey = `${sample.agent}\0${sample.endpoint}\0fixed-traffic-trip`;
    if (fixedTripCorroborated) {
      const sequence = this.#advance(sequenceKey, sample.at);
      const eligible = sample.complete
        && sample.confidence === this.policy.fixedTrip.minimumConfidence
        && sequence.count >= this.policy.consecutiveWindows;
      return this.#result(
        sample,
        eligible ? 'tripped' : 'warning',
        'fixed-traffic-trip',
        sequence.firstAt,
        [{
          code: 'OUTBOUND_BYTES_10M', measured: sample.bytesOutTenMinutes,
          threshold: this.policy.fixedTrip.outboundMiB * MIB,
          windowSeconds: this.policy.trafficWindowMinutes * 60,
        }],
        eligible ? { action: 'pause' } : null,
      );
    }
    this.#sequences.delete(sequenceKey);

    const fixedWarning = sample.bytesOutTenMinutes >= this.policy.fixedWarning.outboundMiB * MIB;
    const fixedCorroborated = Math.max(sample.sessionsTenMinutes, sample.tasksTenMinutes)
      >= this.policy.fixedWarning.sessionsOrTasks;
    if (fixedWarning && fixedCorroborated) {
      return this.#result(sample, 'warning', 'fixed-traffic-warning', sample.at, [{
        code: 'OUTBOUND_BYTES_10M', measured: sample.bytesOutTenMinutes,
        threshold: this.policy.fixedWarning.outboundMiB * MIB,
        windowSeconds: this.policy.trafficWindowMinutes * 60,
      }], null);
    }
    if (sample.bytesOutTenMinutes >= this.policy.fixedTrip.outboundMiB * MIB) {
      return this.#result(sample, 'warning', 'uncorroborated-byte-spike', sample.at, [{
        code: 'OUTBOUND_BYTES_10M', measured: sample.bytesOutTenMinutes,
        threshold: this.policy.fixedTrip.outboundMiB * MIB,
        windowSeconds: this.policy.trafficWindowMinutes * 60,
      }], null);
    }

    const dynamicThreshold = Math.max(
      sample.baseline.median * this.policy.dynamicWarning.medianMultiplier,
      sample.baseline.median + sample.baseline.mad * this.policy.dynamicWarning.madMultiplier,
      this.policy.dynamicWarning.minOutboundMiBPerMinute * MIB,
    );
    const dynamicCorroborated = sample.sessionsPerMinute
        >= this.policy.dynamicWarning.corroborators.sessionsPerMinute
      || sample.tasksPerMinute >= this.policy.dynamicWarning.corroborators.tasksPerMinute
      || sample.connectionsPerMinute >= this.policy.dynamicWarning.corroborators.connectionsPerMinute;
    if (sample.bytesOutPerMinute >= dynamicThreshold && dynamicCorroborated) {
      return this.#result(sample, 'warning', 'dynamic-warning', sample.at, [{
        code: 'OUTBOUND_BYTES_DYNAMIC', measured: sample.bytesOutPerMinute,
        threshold: dynamicThreshold, windowSeconds: this.policy.evaluationWindowSeconds,
      }], null);
    }
    return {
      state: sample.learning ? 'learning' : 'normal',
      level: 'normal', ruleId: null, incidentId: null, evidence: [], control: null,
    };
  }

  #structural(sample: PolicySample): PolicyResult | undefined {
    const recursive = sample.processTree.sameExecutableDepth >= this.policy.structuralTrip.recursiveDepth
      && sample.recursiveTasksInWindow >= this.policy.structuralTrip.recursiveTasks;
    const burst = sample.processTree.newTaskProcesses >= this.policy.structuralTrip.burstTasks
      && sample.processTree.activeTaskProcesses >= this.policy.structuralTrip.burstActiveTasks;
    if (!recursive && !burst) return undefined;
    const ruleId = recursive ? 'structural-recursion-trip' : 'structural-burst-trip';
    const threshold = recursive
      ? this.policy.structuralTrip.recursiveDepth
      : this.policy.structuralTrip.burstTasks;
    const measured = recursive
      ? sample.processTree.sameExecutableDepth
      : sample.processTree.newTaskProcesses;
    const controlEligible = sample.complete
      && sample.confidence === 'confirmed'
      && !sample.processTree.bounded;
    return this.#result(sample, controlEligible ? 'tripped' : 'warning', ruleId, sample.at, [{
      code: recursive ? 'SAME_EXECUTABLE_DEPTH' : 'TASK_PROCESS_BURST',
      measured,
      threshold,
      windowSeconds: recursive
        ? this.policy.structuralTrip.recursiveWindowSeconds
        : this.policy.structuralTrip.burstWindowSeconds,
    }], controlEligible ? { action: 'terminate-recursive-subtree' } : null);
  }

  #advance(key: string, at: number): SequenceState {
    const existing = this.#sequences.get(key);
    const next = existing
      ? { count: existing.count + 1, firstAt: existing.firstAt }
      : { count: 1, firstAt: at };
    this.#sequences.set(key, next);
    return next;
  }

  #result(
    sample: PolicySample,
    state: 'warning' | 'tripped',
    ruleId: string,
    firstAt: number,
    evidence: Array<Omit<PolicyEvidence, 'confidence' | 'complete' | 'policyVersion'>>,
    control: PolicyResult['control'],
  ): PolicyResult {
    const incidentId = createHash('sha256')
      .update(`${sample.agent}\0${sample.endpoint}\0${ruleId}\0${firstAt}`)
      .digest('hex').slice(0, 24);
    return {
      state,
      level: state,
      ruleId,
      incidentId,
      evidence: evidence.map((item) => ({
        ...item,
        confidence: sample.confidence,
        complete: sample.complete,
        policyVersion: 1,
      })),
      control,
    };
  }
}
