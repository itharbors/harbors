import type { TraceRun } from '@itharbors/traceweave-contracts';

export function traceRunFixture(): TraceRun {
  return {
    id: 'run-1',
    source: 'codex',
    title: 'Build orchestration view',
    startedAt: '2026-07-31T08:00:00.000Z',
    endedAt: '2026-07-31T08:00:04.000Z',
    workspace: 'harbors',
    model: 'gpt-5',
    status: 'complete',
    metrics: { durationMs: 4_000, totalTokens: 320 },
    warnings: [],
    turns: [{
      id: 'turn-1',
      index: 1,
      startedAt: '2026-07-31T08:00:00.000Z',
      endedAt: '2026-07-31T08:00:04.000Z',
      userInput: 'Add the TraceWeave panel',
      metrics: { durationMs: 4_000, totalTokens: 320 },
      edges: [
        { id: 'edge-1', from: 'intent-1', to: 'plan-1', relation: 'sequence' },
        { id: 'edge-2', from: 'plan-1', to: 'tool-1', relation: 'sequence' },
        { id: 'edge-3', from: 'tool-1', to: 'response-1', relation: 'result' },
      ],
      nodes: [
        {
          id: 'intent-1', kind: 'intent', label: 'Add the TraceWeave panel', summary: 'User request',
          timestamp: '2026-07-31T08:00:00.000Z', status: 'complete', details: {},
          evidence: { class: 'observed', sourceEventIds: ['event-1'], rawOffsets: [10] },
        },
        {
          id: 'plan-1', kind: 'plan', label: 'Implement the panel', summary: 'Implementation plan',
          timestamp: '2026-07-31T08:00:01.000Z', status: 'complete', details: {},
          evidence: { class: 'derived', sourceEventIds: ['event-2'], rawOffsets: [20] },
        },
        {
          id: 'tool-1', kind: 'tool', label: 'apply_patch', summary: 'Write panel files',
          timestamp: '2026-07-31T08:00:02.000Z', status: 'complete', details: {},
          evidence: { class: 'observed', sourceEventIds: ['event-3'], rawOffsets: [30] },
        },
        {
          id: 'response-1', kind: 'response', label: 'Implementation complete', summary: 'Final response',
          timestamp: '2026-07-31T08:00:03.000Z', status: 'complete', details: {},
          evidence: { class: 'observed', sourceEventIds: ['event-4'], rawOffsets: [40] },
        },
      ],
    }],
  };
}
