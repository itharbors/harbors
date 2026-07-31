import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import panel from '../panel.trace/src/index.js';
import { traceRunFixture } from './fixtures.js';

describe('TraceWeave panel', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '<div id="traceweave-root"></div>';
  });

  afterEach(async () => {
    await act(async () => panel.unmount());
  });

  it('loads runs through the Harbors message bridge and defaults to Flow', async () => {
    const run = traceRunFixture();
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'listRuns') return [{
        id: run.id,
        title: run.title,
        startedAt: run.startedAt,
        updatedAt: run.endedAt,
        workspace: run.workspace,
        model: run.model,
        turnCount: 1,
        durationMs: 4_000,
        archived: false,
        status: run.status,
        warningCount: 0,
      }];
      if (method === 'loadRun') return run;
      throw new Error(`Unexpected method ${method}`);
    });

    await act(async () => panel.mount({ message: { request } }));

    expect(request).toHaveBeenCalledWith('@itharbors/traceweave-core', 'listRuns');
    expect(request).toHaveBeenCalledWith('@itharbors/traceweave-core', 'loadRun', { runId: 'run-1' });
    expect(document.querySelector('[aria-label="Flow overview"]')).not.toBeNull();
    expect(document.body.textContent).toContain('Build orchestration view');
    expect(document.body.textContent).toContain('Input');
    expect(document.body.textContent).toContain('Understand');
    expect(document.body.textContent).toContain('Execute');
    expect(document.body.textContent).toContain('Output');
  });

  it('renders a useful empty state when no Codex sessions are available', async () => {
    const request = vi.fn(async () => []);

    await act(async () => panel.mount({ message: { request } }));

    expect(document.querySelector('[role="status"]')?.textContent).toContain('No Codex runs found');
  });
});
