import { describe, expect, it } from 'vitest';

import { projectEventTurns } from '../panel.trace/src/event-projection.js';
import { traceRunFixture } from './fixtures.js';

describe('projectEventTurns', () => {
  it('preserves recorded edges while applying evidence filters', () => {
    const projected = projectEventTurns(traceRunFixture(), {
      hiddenEvidence: new Set(['derived']),
      hideSuccessfulTools: false,
    });

    expect(projected[0].nodes.map((node) => node.id)).toEqual(['intent-1', 'tool-1', 'response-1']);
    expect(projected[0].edges).toEqual([
      { id: 'edge-3', from: 'tool-1', to: 'response-1', relation: 'result' },
    ]);
  });

  it('supports successful-tool suppression and raw-offset replay', () => {
    const projected = projectEventTurns(traceRunFixture(), {
      hiddenEvidence: new Set(),
      hideSuccessfulTools: true,
      replayOffset: 20,
    });

    expect(projected[0].nodes.map((node) => node.id)).toEqual(['intent-1', 'plan-1']);
    expect(projected[0].edges.map((edge) => edge.id)).toEqual(['edge-1']);
  });
});
