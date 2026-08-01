import { useMemo, useState } from 'react';
import type { EvidenceClass, TraceNode, TraceRun } from '@itharbors/traceweave-contracts';

import { projectEventTurns } from './event-projection.js';

interface EventBoardProps {
  run: TraceRun;
  hiddenEvidence: Set<EvidenceClass>;
  hideSuccessfulTools: boolean;
  replayOffset: number;
  onSelectNode(node: TraceNode): void;
}

const glyph: Record<TraceNode['kind'], string> = {
  intent: 'IN', goal: '◎', plan: '≡', reasoning: '∴', skill: '⬡', tool: '>_', response: 'OUT', subagent: '↳', error: '!',
};

export function EventBoard({ run, hiddenEvidence, hideSuccessfulTools, replayOffset, onSelectNode }: EventBoardProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const turns = useMemo(() => projectEventTurns(run, {
    hiddenEvidence, hideSuccessfulTools, replayOffset,
  }), [run, hiddenEvidence, hideSuccessfulTools, replayOffset]);
  const visibleNodes = turns.reduce((count, turn) => count + turn.nodes.length, 0);

  function toggleTurn(id: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  return (
    <section className="event-board" aria-label="Evidence trace">
      <header className="event-board__header">
        <div><p className="eyebrow">Evidence trace</p><h2>{run.title}</h2></div>
        <dl><div><dt>Visible</dt><dd>{visibleNodes}</dd></div><div><dt>Recorded</dt><dd>{run.turns.reduce((sum, turn) => sum + turn.nodes.length, 0)}</dd></div></dl>
      </header>
      <div className="event-board__legend" aria-label="Event columns">
        {['Input', 'Goal / plan', 'Reasoning', 'Skill', 'Tool', 'Sub-agent', 'Response', 'Error'].map((name) => <span key={name}>{name}</span>)}
      </div>
      <ol className="event-board__turns">
        {turns.map((turn) => {
          const isCollapsed = collapsed.has(turn.id);
          return (
            <li key={turn.id}>
              <article className="event-turn" aria-label={`Turn ${turn.index} events`}>
                <header>
                  <button type="button" aria-expanded={!isCollapsed} onClick={() => toggleTurn(turn.id)}>T{String(turn.index).padStart(2, '0')}</button>
                  <strong>{turn.userInput ?? 'No input recorded'}</strong>
                  <span>{turn.nodes.length} visible · {turn.edges.length} links</span>
                </header>
                {!isCollapsed ? (
                  <div className="event-turn__track">
                    {turn.nodes.length ? turn.nodes.map((node, index) => {
                      const inbound = turn.edges.filter((edge) => edge.to === node.id);
                      return (
                        <div className={`event-node event-node--${node.kind}`} key={node.id}>
                          {index ? <span className="event-node__connector" aria-hidden="true">→</span> : null}
                          <button type="button" aria-label={`${node.kind}: ${node.label}. ${node.evidence.class}. ${node.status}.`} onClick={() => onSelectNode(node)}>
                            <span className="event-node__top"><i aria-hidden="true">{glyph[node.kind]}</i><em>{node.kind}</em><b>{node.status}</b></span>
                            <strong>{node.label}</strong>
                            <small>{node.summary}</small>
                            <span className={`evidence-pill evidence-pill--${node.evidence.class}`}>{node.evidence.class}</span>
                            {inbound.length ? <span className="event-node__relation">{inbound.map((edge) => edge.relation).join(' · ')}</span> : null}
                          </button>
                        </div>
                      );
                    }) : <p className="event-turn__empty">No events match the current evidence filters or replay position.</p>}
                  </div>
                ) : null}
              </article>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
