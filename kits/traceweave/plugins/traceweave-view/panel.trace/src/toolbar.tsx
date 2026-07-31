export type TraceView = 'flow' | 'events';

interface ToolbarProps {
  view: TraceView;
  onViewChange(view: TraceView): void;
  onRefresh(): void;
  refreshing: boolean;
}

export function Toolbar({ view, onViewChange, onRefresh, refreshing }: ToolbarProps) {
  return (
    <div className="trace-toolbar">
      <div className="trace-toolbar__switch" aria-label="Trace view">
        <button type="button" aria-pressed={view === 'flow'} onClick={() => onViewChange('flow')}>Flow</button>
        <button type="button" aria-pressed={view === 'events'} onClick={() => onViewChange('events')}>Events</button>
      </div>
      <button className="trace-toolbar__refresh" type="button" onClick={onRefresh} disabled={refreshing}>
        <span aria-hidden="true">↻</span>{refreshing ? 'Refreshing' : 'Refresh'}
      </button>
    </div>
  );
}
