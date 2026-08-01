import type { RunSummary } from '@itharbors/traceweave-contracts';
import { useEffect, useState } from 'react';

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
  const activeRuns = runs.filter(run => !run.archived);
  const archivedRuns = runs.filter(run => run.archived);
  const selectedIsActive = activeRuns.some(run => run.id === selectedId);
  const selectedIsArchived = archivedRuns.some(run => run.id === selectedId);
  const [visibleGroup, setVisibleGroup] = useState<'active' | 'archived'>(
    selectedIsArchived ? 'archived' : 'active',
  );

  useEffect(() => { if (selectedIsActive) setVisibleGroup('active'); }, [selectedIsActive]);
  useEffect(() => { if (selectedIsArchived) setVisibleGroup('archived'); }, [selectedIsArchived]);

  function groupToggle(
    label: 'Active' | 'Archived',
    groupedRuns: RunSummary[],
  ) {
    const group = label === 'Active' ? 'active' : 'archived';
    const id = `traceweave-${group}-sessions`;
    const open = visibleGroup === group;
    return (
      <button
        type="button"
        className="run-rail__group-toggle"
        aria-label={`${label} sessions, ${groupedRuns.length}`}
        aria-controls={id}
        aria-expanded={open}
        onClick={() => setVisibleGroup(group)}
      >
        <span>{label}</span>
        <b>{groupedRuns.length}</b>
        <i aria-hidden="true">⌄</i>
      </button>
    );
  }

  function groupList(label: 'Active' | 'Archived', groupedRuns: RunSummary[]) {
    const id = `traceweave-${label.toLowerCase()}-sessions`;
    return (
      <ol id={id} aria-label={`${label} sessions`}>
        {groupedRuns.map((run) => (
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
              <small>{run.turnCount === undefined ? 'Session' : `${run.turnCount} turns`} · {run.workspace ?? 'Unknown workspace'}</small>
            </button>
          </li>
        ))}
      </ol>
    );
  }

  return (
    <aside className="run-rail" aria-label="Codex sessions">
      <div className="run-rail__title">
        <span>Sessions</span><b>{runs.length}</b>
      </div>
      <div className="run-rail__group-controls" aria-label="Session categories">
        {groupToggle('Active', activeRuns)}
        {groupToggle('Archived', archivedRuns)}
      </div>
      {visibleGroup === 'active' && groupList('Active', activeRuns)}
      {visibleGroup === 'archived' && groupList('Archived', archivedRuns)}
    </aside>
  );
}
