import type { EvidenceClass, TraceEdge, TraceNode, TraceRun, TraceTurn } from '@itharbors/traceweave-contracts';

export interface EventProjectionOptions {
  hiddenEvidence: Set<EvidenceClass>;
  hideSuccessfulTools: boolean;
  replayOffset?: number;
}

export interface EventTurn extends Omit<TraceTurn, 'nodes' | 'edges'> {
  nodes: TraceNode[];
  edges: TraceEdge[];
}

function visible(node: TraceNode, options: EventProjectionOptions): boolean {
  if (options.hiddenEvidence.has(node.evidence.class)) return false;
  if (options.hideSuccessfulTools && node.kind === 'tool' && node.status === 'complete') return false;
  if (options.replayOffset !== undefined) {
    if (!node.evidence.rawOffsets.length) return false;
    if (Math.min(...node.evidence.rawOffsets) > options.replayOffset) return false;
  }
  return true;
}

export function projectEventTurns(run: TraceRun, options: EventProjectionOptions): EventTurn[] {
  return run.turns.map((turn) => {
    const nodes = turn.nodes.filter((node) => visible(node, options));
    const ids = new Set(nodes.map((node) => node.id));
    return {
      ...turn,
      nodes,
      edges: turn.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
    };
  });
}
