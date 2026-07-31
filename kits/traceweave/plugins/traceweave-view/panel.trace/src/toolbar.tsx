import type { EvidenceClass } from '@itharbors/traceweave-contracts';
import type { ReplayState } from './use-replay.js';

export type TraceView = 'flow' | 'events';
export type EvidenceVisibility = Record<EvidenceClass, boolean>;

interface ToolbarProps {
  view: TraceView;
  onViewChange(view: TraceView): void;
  onRefresh(): void;
  refreshing: boolean;
  visibility: EvidenceVisibility;
  onToggleEvidence(value: EvidenceClass): void;
  hideSuccessfulTools: boolean;
  onToggleSuccessfulTools(): void;
  replay: ReplayState;
}

export function Toolbar({ view, onViewChange, onRefresh, refreshing, visibility, onToggleEvidence, hideSuccessfulTools, onToggleSuccessfulTools, replay }: ToolbarProps) {
  return (
    <div className="trace-toolbar">
      <div className="trace-toolbar__switch" aria-label="Trace view">
        <button type="button" aria-pressed={view === 'flow'} onClick={() => onViewChange('flow')}>Flow</button>
        <button type="button" aria-pressed={view === 'events'} onClick={() => onViewChange('events')}>Events</button>
      </div>
      {view === 'events' ? (
        <div className="trace-toolbar__filters" aria-label="Evidence visibility">
          {(['observed', 'derived', 'inferred'] as EvidenceClass[]).map((classification) => (
            <label key={classification}><input type="checkbox" checked={visibility[classification]} onChange={() => onToggleEvidence(classification)} /><i aria-hidden="true" />{classification}</label>
          ))}
          <label><input type="checkbox" aria-label="Hide successful tools" checked={hideSuccessfulTools} onChange={onToggleSuccessfulTools} /><i aria-hidden="true" />hide tools</label>
        </div>
      ) : null}
      <div className="trace-toolbar__replay">
        <button type="button" aria-label={replay.playing ? 'Pause replay' : 'Play replay'} onClick={replay.toggle}>{replay.playing ? 'Ⅱ' : '▶'}</button>
        <button type="button" aria-label="Reset replay" onClick={replay.reset}>↺</button>
        <input type="range" min="0" max={replay.max} value={replay.offset} aria-label="Replay position" onChange={(event) => replay.setOffset(Number(event.target.value))} />
        <output>{replay.offset}/{replay.max}</output>
      </div>
      <button className="trace-toolbar__refresh" type="button" onClick={onRefresh} disabled={refreshing}>
        <span aria-hidden="true">↻</span>{refreshing ? 'Refreshing' : 'Refresh'}
      </button>
    </div>
  );
}
