import type { RunSummary } from '@itharbors/traceweave-contracts';

interface RunRailProps {
  runs: RunSummary[];
  selectedId?: string;
  onSelect(id: string): void;
}

function compactDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

export function RunRail({ runs, selectedId, onSelect }: RunRailProps) {
  return (
    <aside className="run-rail" aria-label="Codex runs">
      <div className="run-rail__title">
        <span>Runs</span><b>{runs.length}</b>
      </div>
      <ol>
        {runs.map((run) => (
          <li key={run.id}>
            <button
              type="button"
              className={run.id === selectedId ? 'is-selected' : ''}
              aria-current={run.id === selectedId ? 'true' : undefined}
              onClick={() => onSelect(run.id)}
            >
              <span className={`run-rail__status run-rail__status--${run.status}`} aria-hidden="true" />
              <strong>{run.title}</strong>
              <span>{compactDate(run.updatedAt)}</span>
              <small>{run.turnCount ?? '—'} turns · {run.workspace ?? 'Unknown workspace'}</small>
            </button>
          </li>
        ))}
      </ol>
    </aside>
  );
}
