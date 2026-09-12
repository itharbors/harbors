import { cpus, platform, release, tmpdir } from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ContextStore } from '../main/src/store.js';

const turnCounts = [1, 10, 50, 100] as const;
const samples = Math.max(1, Number.parseInt(process.env.HARBORS_P100_SAMPLES || '30', 10));

function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function conversation(id: string) {
  const now = new Date(0).toISOString();
  return { id, title: 'P100', sandboxMode: 'read-only' as const, approvalPolicy: 'ask' as const, createdAt: now, updatedAt: now };
}

async function runScenario(turns: number) {
  const directory = await mkdtemp(join(tmpdir(), `harbors-p100-${turns}-`));
  const store = new ContextStore(directory);
  try {
    const conversationId = `${String(turns).padStart(8, '0')}-0000-4000-8000-000000000100`;
    store.createConversation(conversation(conversationId));
    const appendMs: number[] = [];
    for (let turn = 1; turn <= turns; turn += 1) {
      const started = performance.now();
      store.appendEvent({ conversationId, idempotencyKey: String(turn), event: { type: 'user/message', time: turn, data: { turn, content: turn === 1 ? `关键锚点 src/p-${turns}.ts E_P_${turns}` : `第 ${turn} 轮普通讨论 ${'x'.repeat(120)}`, message: { role: 'user', content: turn === 1 ? `关键锚点 src/p-${turns}.ts E_P_${turns}` : `第 ${turn} 轮普通讨论 ${'x'.repeat(120)}` } }, surfaceOp: 'append' } });
      appendMs.push(performance.now() - started);
    }
    const currentBuildMs: number[] = [];
    const candidateBuildMs: number[] = [];
    let currentSourceCount = 0;
    let candidateSourceCount = 0;
    for (let sample = 0; sample < samples; sample += 1) {
      let started = performance.now();
      const current = store.buildContext({ conversationId, turn: turns, step: 1, availableInputTokens: 20_000, budgetBreakdown: {}, mode: 'surface-v1' });
      currentBuildMs.push(performance.now() - started);
      started = performance.now();
      const candidate = store.buildContext({ conversationId, turn: turns, step: 1, availableInputTokens: 800, budgetBreakdown: {}, anchors: [`src/p-${turns}.ts`, `E_P_${turns}`], mode: 'candidate-v1' });
      candidateBuildMs.push(performance.now() - started);
      currentSourceCount = current.sourceSeqs.length;
      candidateSourceCount = candidate.sourceSeqs.length;
    }
    return { turns, appendMs, currentBuildMs, candidateBuildMs, currentSourceCount, candidateSourceCount };
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const scenarios = [];
for (const turns of turnCounts) scenarios.push(await runScenario(turns));
const ten = scenarios.find((scenario) => scenario.turns === 10)!;
const hundred = scenarios.find((scenario) => scenario.turns === 100)!;
const hundredCandidateP95 = percentile95(hundred.candidateBuildMs);
const gates = {
  candidateSourceCountAtMost9: scenarios.every((scenario) => scenario.candidateSourceCount <= 9),
  hundredCandidateVsSurfaceAtMost2x: hundredCandidateP95 <= percentile95(hundred.currentBuildMs) * 2,
  hundredCandidateVsTenAtMost4x: hundredCandidateP95 <= percentile95(ten.candidateBuildMs) * 4,
};
const passed = Object.values(gates).every(Boolean);
const report = {
  suite: 'P100', status: passed ? 'passed' : 'failed', generatedAt: new Date().toISOString(), samplesPerBuildVariant: samples,
  environment: { node: process.version, platform: platform(), osRelease: release(), arch: process.arch, cpu: cpus()[0]?.model || 'unknown', cpuCount: cpus().length },
  gates,
  scenarios,
};
const rendered = `${JSON.stringify(report, null, 2)}\n`;
if (process.env.HARBORS_P100_OUTPUT) await writeFile(process.env.HARBORS_P100_OUTPUT, rendered, 'utf8');
process.stdout.write(rendered);
if (!passed) process.exitCode = 1;
