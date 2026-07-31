import { useEffect, useMemo, useRef, useState } from 'react';
import type { RawEvidenceResponse, TraceNode } from '@itharbors/traceweave-contracts';

import type { TraceweaveClient } from './api.js';

interface InspectorProps {
  runId: string;
  node: TraceNode;
  api: TraceweaveClient;
  onClose(): void;
}

function json(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

export function Inspector({ runId, node, api, onClose }: InspectorProps) {
  const [raw, setRaw] = useState<RawEvidenceResponse>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const closeRef = useRef<HTMLButtonElement>(null);
  const details = useMemo(() => json(node.details), [node]);
  const eventId = node.evidence.sourceEventIds[0];

  useEffect(() => { closeRef.current?.focus(); }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [onClose]);
  useEffect(() => {
    let active = true;
    setRaw(undefined); setError(undefined); setLoading(true);
    api.loadRawEvidence(runId, eventId)
      .then((value) => { if (active) setRaw(value); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : 'Raw evidence could not be loaded'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, eventId, runId]);

  return (
    <aside className="inspector" aria-label="Evidence inspector">
      <header><div><p className="eyebrow">Evidence inspector</p><h2>{node.label}</h2></div><button ref={closeRef} type="button" aria-label="Close evidence inspector" onClick={onClose}>×</button></header>
      <div className="inspector__body">
        <section className="inspector__verdict">
          <span className={`evidence-pill evidence-pill--${node.evidence.class}`}>{node.evidence.class}{node.evidence.confidence === undefined ? '' : ` · ${Math.round(node.evidence.confidence * 100)}%`}</span>
          <span className={`node-state node-state--${node.status}`}>{node.status}</span>
          <p>{node.summary ?? 'No summary was recorded for this event.'}</p>
        </section>
        <section className="inspector__section"><h3>Why this node exists</h3><dl><div><dt>Rule</dt><dd>{node.evidence.rule ?? 'Direct Codex event'}</dd></div><div><dt>Kind</dt><dd>{node.kind}</dd></div><div><dt>Sources</dt><dd>{node.evidence.sourceEventIds.length}</dd></div></dl></section>
        <section className="inspector__section"><h3>Normalized details</h3><pre>{details}</pre></section>
        <section className="inspector__section"><h3>Supporting raw event</h3>
          {loading ? <p className="inspector__notice">Loading local evidence…</p> : null}
          {error ? <p className="inspector__notice inspector__notice--error">{error}</p> : null}
          {raw ? <pre>{json(raw.event)}</pre> : null}
          {raw?.truncated ? <p className="inspector__notice">Evidence output was truncated at 64 KiB.</p> : null}
          <ul>{node.evidence.sourceEventIds.map((id, index) => <li key={id}><span>#{node.evidence.rawOffsets[index]}</span>{id}</li>)}</ul>
        </section>
      </div>
    </aside>
  );
}
