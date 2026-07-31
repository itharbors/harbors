import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EvidenceClass, RunSummary, TraceNode, TraceRun } from '@itharbors/traceweave-contracts';

import type { TraceweaveClient } from './api.js';
import { EventBoard } from './event-board.js';
import { FlowOverview } from './flow-overview.js';
import { Inspector } from './inspector.js';
import { RunRail } from './run-rail.js';
import { StatusView } from './status-view.js';
import { Toolbar, type EvidenceVisibility, type TraceView } from './toolbar.js';
import { usePrefersReducedMotion, useReplay } from './use-replay.js';

interface AppProps { api: TraceweaveClient }

export function App({ api }: AppProps) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [run, setRun] = useState<TraceRun>();
  const [view, setView] = useState<TraceView>('flow');
  const [selectedNode, setSelectedNode] = useState<TraceNode>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const [visibility, setVisibility] = useState<EvidenceVisibility>({ observed: true, derived: true, inferred: true });
  const [hideSuccessfulTools, setHideSuccessfulTools] = useState(false);
  const maxOffset = useMemo(() => Math.max(0, ...(run?.turns.flatMap((turn) => turn.nodes.flatMap((node) => node.evidence.rawOffsets)) ?? [])), [run]);
  const replay = useReplay(maxOffset, usePrefersReducedMotion());
  const hiddenEvidence = useMemo(() => new Set(
    (Object.keys(visibility) as EvidenceClass[]).filter((classification) => !visibility[classification]),
  ), [visibility]);

  const selectRun = useCallback(async (runId: string) => {
    setSelectedId(runId);
    setRun(undefined);
    setSelectedNode(undefined);
    setError(undefined);
    setLoading(true);
    try { setRun(await api.loadRun(runId)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not load the run'); }
    finally { setLoading(false); }
  }, [api]);

  const loadRuns = useCallback(async () => {
    setError(undefined);
    setLoading(true);
    try {
      const next = await api.listRuns();
      setRuns(next);
      if (next.length) await selectRun(next[0].id);
      else setLoading(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not scan Codex sessions');
      setLoading(false);
    }
  }, [api, selectRun]);

  useEffect(() => { void loadRuns(); }, [loadRuns]);

  async function refresh() {
    setRefreshing(true);
    setError(undefined);
    try {
      const next = await api.refresh();
      setRuns(next);
      const nextId = next.some((item) => item.id === selectedId) ? selectedId : next[0]?.id;
      if (nextId) await selectRun(nextId);
      else {
        setRun(undefined);
        setSelectedId(undefined);
        setLoading(false);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not refresh Codex sessions');
    } finally { setRefreshing(false); }
  }

  return (
    <div className="trace-shell">
      <header className="trace-header">
        <div className="trace-brand"><span aria-hidden="true">TW</span><div><strong>TraceWeave</strong><small>Codex orchestration observatory</small></div></div>
        <Toolbar
          view={view} onViewChange={setView} onRefresh={() => void refresh()} refreshing={refreshing}
          visibility={visibility}
          onToggleEvidence={(classification) => setVisibility((current) => ({ ...current, [classification]: !current[classification] }))}
          hideSuccessfulTools={hideSuccessfulTools}
          onToggleSuccessfulTools={() => setHideSuccessfulTools((current) => !current)}
          replay={replay}
        />
      </header>
      <div className="trace-workbench">
        <RunRail runs={runs} selectedId={selectedId} onSelect={(id) => void selectRun(id)} />
        <main className="trace-main">
          {error ? <StatusView title="Trace unavailable" detail={error} action="Try again" onAction={() => void loadRuns()} />
            : loading ? <StatusView title="Reading Codex sessions" detail="Parsing local rollout evidence…" />
              : !runs.length ? <StatusView title="No Codex runs found" detail="TraceWeave reads local sessions from your configured Codex home." action="Refresh" onAction={() => void refresh()} />
                : run && view === 'flow' ? <FlowOverview run={run} onSelectNode={setSelectedNode} replayOffset={replay.offset} />
                  : run ? <EventBoard run={run} hiddenEvidence={hiddenEvidence} hideSuccessfulTools={hideSuccessfulTools} replayOffset={replay.offset} onSelectNode={setSelectedNode} /> : null}
        </main>
        {selectedNode && run ? <Inspector runId={run.id} node={selectedNode} api={api} onClose={() => setSelectedNode(undefined)} /> : null}
      </div>
    </div>
  );
}
