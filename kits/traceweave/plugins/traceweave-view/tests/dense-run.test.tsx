import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TraceNode } from '@itharbors/traceweave-contracts';

import { FlowOverview } from '../panel.trace/src/flow-overview.js';
import { projectFlowTurns } from '../panel.trace/src/flow-projection.js';
import { traceRunFixture } from './fixtures.js';

describe('dense Flow projection', () => {
  it('keeps one four-stage spine for a 4,000-node turn', () => {
    const run = traceRunFixture();
    const template = run.turns[0].nodes[2];
    run.turns[0].nodes = Array.from({ length: 4_000 }, (_, index): TraceNode => ({
      ...template,
      id: `tool-${index}`,
      label: `tool ${index}`,
      evidence: { ...template.evidence, sourceEventIds: [`event-${index}`], rawOffsets: [index] },
    }));

    expect(projectFlowTurns(run).at(0)?.stages).toHaveLength(4);
    const markup = renderToStaticMarkup(<FlowOverview run={run} onSelectNode={() => {}} />);
    expect((markup.match(/class="flow-stage /g) ?? [])).toHaveLength(4);
    expect(markup.length).toBeLessThan(20_000);
  });
});
