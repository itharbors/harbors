import { describe, expect, it } from 'vitest';

import { projectFlowTurns } from '../panel.trace/src/flow-projection.js';
import { traceRunFixture } from './fixtures.js';

describe('projectFlowTurns', () => {
  it('projects every turn into the fixed input-understand-execute-output sequence', () => {
    const [turn] = projectFlowTurns(traceRunFixture(), {});

    expect(turn.stages.map((stage) => stage.kind)).toEqual([
      'input', 'understand', 'execute', 'output',
    ]);
    expect(turn.stages.map((stage) => stage.label)).toEqual([
      'Add the TraceWeave panel', 'Implement the panel', 'apply_patch', 'Implementation complete',
    ]);
    expect(turn.stages[1].evidenceCounts.derived).toBe(1);
  });

  it('hides nodes beyond the replay offset without inventing missing stages', () => {
    const [turn] = projectFlowTurns(traceRunFixture(), { replayOffset: 20 });

    expect(turn.stages[0].nodes).toHaveLength(1);
    expect(turn.stages[1].nodes).toHaveLength(1);
    expect(turn.stages[2].nodes).toHaveLength(0);
    expect(turn.stages[2].label).toBe('No recorded actions');
    expect(turn.stages[3].nodes).toHaveLength(0);
  });
});
