import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { normalizeCodexRun } from '../main/src/normalize';
import { parseRollout } from '../main/src/parse-rollout';
import type { ParsedRollout } from '../main/src/parse-rollout';

const fixture = fileURLToPath(new URL('./fixtures/two-turn.jsonl', import.meta.url));
const load = async () => normalizeCodexRun(await parseRollout(createReadStream(fixture)));

describe('normalizeCodexRun', () => {
  it('builds two turns with truthful intent, skill, tool, sub-agent and response evidence', async () => {
    const run = await load();
    expect(run.turns.map(turn => turn.id)).toEqual(['turn-1', 'turn-2']);
    expect(run.turns[0].nodes.map(node => node.kind)).toEqual(expect.arrayContaining([
      'intent', 'goal', 'reasoning', 'skill', 'tool', 'subagent', 'response',
    ]));
    expect(run.turns[0].nodes.find(node => node.kind === 'skill')).toMatchObject({
      label: 'imagegen', evidence: { class: 'inferred', confidence: 0.9, rule: 'skill_md_read' },
    });
    expect(run.turns[0].nodes.find(node => node.kind === 'subagent')).toMatchObject({
      label: 'model_helper', status: 'complete', details: { callId: 'call-agent', hasOutput: true },
    });
  });

  it('correlates tool outputs and aggregates recorded metrics without inventing fields', async () => {
    const run = await load();
    expect(run.turns[1].nodes.find(node => node.kind === 'tool')).toMatchObject({
      label: 'image_edit', status: 'complete', details: { hasOutput: true },
    });
    expect(run.turns[0].metrics).toEqual({ durationMs: 2000, timeToFirstTokenMs: 240 });
    expect(run.metrics).toMatchObject({ inputTokens: 1900, outputTokens: 260, totalTokens: 2160 });
    expect(run.turns.flatMap(turn => turn.nodes).every(node =>
      node.evidence.sourceEventIds.length > 0 && node.evidence.rawOffsets.length > 0,
    )).toBe(true);
  });

  it('keeps an unpaired tool as unknown and reports its missing result', () => {
    const parsed: ParsedRollout = {
      sessionId: 'session-unpaired',
      warnings: [],
      events: [
        { id: 'start', rawOffset: 1, timestamp: '2026-07-31T00:00:00Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' }, raw: {} },
        { id: 'call', rawOffset: 2, timestamp: '2026-07-31T00:00:01Z', type: 'response_item', payload: { type: 'function_call', call_id: 'missing', name: 'lookup', arguments: '{}' }, raw: {} },
        { id: 'done', rawOffset: 3, timestamp: '2026-07-31T00:00:02Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' }, raw: {} },
      ],
    };
    const run = normalizeCodexRun(parsed);
    expect(run.turns[0].nodes[0]).toMatchObject({ label: 'lookup', status: 'unknown' });
    expect(run.warnings).toContainEqual(expect.objectContaining({ code: 'missing_pair', line: 2 }));
  });
});
