import type { FlowStage } from './flow-projection.js';

const stageLabel: Record<FlowStage['kind'], string> = {
  input: 'Input',
  understand: 'Understand',
  execute: 'Execute',
  output: 'Output',
};

function countLabel(stage: FlowStage): string {
  const count = stage.nodes.length;
  const noun = stage.kind === 'execute' ? 'action' : stage.kind === 'understand' ? 'signal' : stage.kind;
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

interface FlowStageCardProps {
  stage: FlowStage;
  expanded: boolean;
  controlsId: string;
  onToggle(): void;
}

export function FlowStageCard({ stage, expanded, controlsId, onToggle }: FlowStageCardProps) {
  const title = stageLabel[stage.kind];
  const count = countLabel(stage);
  const body = (
    <>
      <span className="flow-stage__topline"><span>{title}</span><i>{stage.nodes.length ? count : 'Empty'}</i></span>
      <strong>{stage.label}</strong>
      <span className="flow-stage__summary">{stage.nodes.length ? stage.summary : 'No matching evidence was recorded.'}</span>
      {stage.nodes.length ? (
        <span className="flow-stage__footer">
          <span>{stage.evidenceCounts.observed} observed</span>
          {stage.evidenceCounts.derived ? <span>{stage.evidenceCounts.derived} derived</span> : null}
          {stage.evidenceCounts.inferred ? <span>{stage.evidenceCounts.inferred} inferred</span> : null}
        </span>
      ) : null}
    </>
  );

  return (
    <div className={`flow-stage flow-stage--${stage.kind} flow-stage--${stage.status}`}>
      {stage.nodes.length ? (
        <button
          type="button"
          aria-label={`${title}: ${stage.label}. ${count}. ${stage.status}.`}
          aria-expanded={expanded}
          aria-controls={controlsId}
          onClick={onToggle}
        >{body}</button>
      ) : <div className="flow-stage__empty" aria-label={`${title}: ${stage.label}`}>{body}</div>}
    </div>
  );
}
