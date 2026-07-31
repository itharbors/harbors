import type {
  EvidenceClass,
  TraceMetrics,
  TraceNode,
  TraceRun,
  TraceStatus,
  TraceTurn,
} from '@itharbors/traceweave-contracts';

export type FlowStageKind = 'input' | 'understand' | 'execute' | 'output';

export interface FlowStage {
  id: string;
  kind: FlowStageKind;
  label: string;
  summary: string;
  nodes: TraceNode[];
  status: TraceStatus;
  evidenceCounts: Record<EvidenceClass, number>;
  startOffset?: number;
  endOffset?: number;
}

export interface FlowTurn {
  id: string;
  index: number;
  input: string;
  metrics: TraceMetrics;
  stages: [FlowStage, FlowStage, FlowStage, FlowStage];
}

export interface FlowProjectionOptions {
  replayOffset?: number;
}

const stageKinds: Record<FlowStageKind, ReadonlySet<TraceNode['kind']>> = {
  input: new Set(['intent']),
  understand: new Set(['goal', 'plan', 'reasoning']),
  execute: new Set(['skill', 'tool', 'subagent', 'error']),
  output: new Set(['response']),
};

const emptyLabel: Record<FlowStageKind, string> = {
  input: 'No input recorded',
  understand: 'No recorded planning',
  execute: 'No recorded actions',
  output: 'No output recorded',
};

const statusSeverity: TraceStatus[] = ['failed', 'running', 'pending', 'unknown', 'complete'];

function isRevealed(node: TraceNode, replayOffset?: number): boolean {
  if (replayOffset === undefined) return true;
  return node.evidence.rawOffsets.length > 0
    && Math.min(...node.evidence.rawOffsets) <= replayOffset;
}

function stageStatus(nodes: TraceNode[]): TraceStatus {
  if (!nodes.length) return 'unknown';
  return statusSeverity.find((status) => nodes.some((node) => node.status === status)) ?? 'unknown';
}

function countEvidence(nodes: TraceNode[]): Record<EvidenceClass, number> {
  return nodes.reduce<Record<EvidenceClass, number>>((counts, node) => {
    counts[node.evidence.class] += 1;
    return counts;
  }, { observed: 0, derived: 0, inferred: 0 });
}

function projectStage(turn: TraceTurn, kind: FlowStageKind, replayOffset?: number): FlowStage {
  const nodes = turn.nodes.filter((node) => stageKinds[kind].has(node.kind) && isRevealed(node, replayOffset));
  const representative = kind === 'output' ? nodes.at(-1) : nodes[0];
  const offsets = nodes.flatMap((node) => node.evidence.rawOffsets);
  const label = kind === 'execute' && representative && nodes.length > 1
    ? `${representative.label} + ${nodes.length - 1} more`
    : representative?.label ?? emptyLabel[kind];

  return {
    id: `${turn.id}-${kind}`,
    kind,
    label,
    summary: representative?.summary ?? emptyLabel[kind],
    nodes,
    status: stageStatus(nodes),
    evidenceCounts: countEvidence(nodes),
    startOffset: offsets.length ? Math.min(...offsets) : undefined,
    endOffset: offsets.length ? Math.max(...offsets) : undefined,
  };
}

export function projectFlowTurns(run: TraceRun, options: FlowProjectionOptions = {}): FlowTurn[] {
  return run.turns.map((turn) => {
    const stages: FlowTurn['stages'] = [
      projectStage(turn, 'input', options.replayOffset),
      projectStage(turn, 'understand', options.replayOffset),
      projectStage(turn, 'execute', options.replayOffset),
      projectStage(turn, 'output', options.replayOffset),
    ];
    return {
      id: turn.id,
      index: turn.index,
      input: stages[0].nodes.length ? turn.userInput ?? stages[0].label : stages[0].label,
      metrics: turn.metrics,
      stages,
    };
  });
}
