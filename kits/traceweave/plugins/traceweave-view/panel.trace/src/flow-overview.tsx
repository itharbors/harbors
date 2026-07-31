import { useMemo, useState } from 'react';
import type { TraceNode, TraceRun } from '@itharbors/traceweave-contracts';

import { FlowStageCard } from './flow-stage.js';
import { projectFlowTurns } from './flow-projection.js';

interface FlowOverviewProps {
  run: TraceRun;
  onSelectNode(node: TraceNode): void;
  replayOffset?: number;
}

const stageTitle = { input: 'Input', understand: 'Understand', execute: 'Execute', output: 'Output' } as const;

function metric(value?: number, unit = ''): string {
  return value === undefined ? '—' : `${new Intl.NumberFormat().format(value)}${unit}`;
}

export function FlowOverview({ run, onSelectNode, replayOffset }: FlowOverviewProps) {
  const turns = useMemo(() => projectFlowTurns(run, { replayOffset }), [run, replayOffset]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Record<string, string | undefined>>({});
  const stepCount = run.turns.reduce((count, turn) => count + turn.nodes.length, 0);

  function toggleTurn(turnId: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      next.has(turnId) ? next.delete(turnId) : next.add(turnId);
      return next;
    });
  }

  return (
    <section className="flow-overview" aria-label="Flow overview">
      <header className="flow-overview__header">
        <div><p className="eyebrow">Flow overview</p><h2>{run.title}</h2></div>
        <dl>
          <div><dt>Turns</dt><dd>{run.turns.length}</dd></div>
          <div><dt>Steps</dt><dd>{stepCount}</dd></div>
          <div><dt>Tokens</dt><dd>{run.metrics.totalTokens?.toLocaleString() ?? '—'}</dd></div>
        </dl>
      </header>
      {run.warnings.length ? (
        <div className="flow-overview__warning" role="status">
          <strong>{run.warnings.length} import warning{run.warnings.length === 1 ? '' : 's'}</strong>
          <span>Valid evidence is still included in this flow.</span>
        </div>
      ) : null}
      <ol className="flow-overview__turns">
        {turns.map((turn) => {
          const isCollapsed = collapsed.has(turn.id);
          const expandedStage = turn.stages.find((stage) => expanded[turn.id] === stage.id);
          return (
            <li className="flow-turn" key={turn.id}>
              <article aria-label={`Turn ${turn.index} flow`}>
                <header className="flow-turn__header">
                  <span className="flow-turn__index">T{String(turn.index).padStart(2, '0')}</span>
                  <div><span>Turn input</span><strong>{turn.input}</strong></div>
                  <dl>
                    <div><dt>Time</dt><dd>{metric(turn.metrics.durationMs === undefined ? undefined : Math.round(turn.metrics.durationMs / 100) / 10, 's')}</dd></div>
                    <div><dt>Tokens</dt><dd>{metric(turn.metrics.totalTokens)}</dd></div>
                  </dl>
                  <button type="button" aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} turn ${turn.index}`} onClick={() => toggleTurn(turn.id)}>{isCollapsed ? '+' : '−'}</button>
                </header>
                {!isCollapsed ? (
                  <>
                    <div className="flow-turn__pipeline">
                      {turn.stages.map((stage) => (
                        <FlowStageCard
                          key={stage.id}
                          stage={stage}
                          expanded={expanded[turn.id] === stage.id}
                          controlsId={`${stage.id}-details`}
                          onToggle={() => setExpanded((current) => ({
                            ...current,
                            [turn.id]: current[turn.id] === stage.id ? undefined : stage.id,
                          }))}
                        />
                      ))}
                    </div>
                    {expandedStage ? (
                      <section className="flow-detail" id={`${expandedStage.id}-details`} aria-label={`${stageTitle[expandedStage.kind]} details for turn ${turn.index}`}>
                        <header><strong>{stageTitle[expandedStage.kind]} evidence</strong><span>Chronological · evidence-backed</span></header>
                        <ol>{expandedStage.nodes.map((node, index) => (
                          <li key={node.id}>
                            <button type="button" onClick={() => onSelectNode(node)}>
                              <span>{String(index + 1).padStart(2, '0')}</span><i>{node.kind}</i><strong>{node.label}</strong><em>{node.evidence.class}</em><b>{node.status}</b>
                            </button>
                          </li>
                        ))}</ol>
                      </section>
                    ) : null}
                  </>
                ) : null}
              </article>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
