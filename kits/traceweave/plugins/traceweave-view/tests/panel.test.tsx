import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import panel from '../panel.trace/src/index.js';
import { traceRunFixture } from './fixtures.js';

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find((item) =>
    item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
  );
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
  return match;
}

async function click(target: HTMLElement) {
  await act(async () => target.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

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

  it('switches to the filterable Events view and replays recorded evidence', async () => {
    const run = traceRunFixture();
    const request = vi.fn(async (_plugin: string, method: string) => method === 'listRuns'
      ? [{ id: run.id, title: run.title, startedAt: run.startedAt, updatedAt: run.endedAt, archived: false, status: run.status, warningCount: 0 }]
      : run);
    await act(async () => panel.mount({ message: { request } }));

    await click(button('Events'));
    expect(document.querySelector('[aria-label="Evidence trace"]')).not.toBeNull();
    expect(document.body.textContent).toContain('apply_patch');

    const hideTools = document.querySelector<HTMLInputElement>('input[aria-label="Hide successful tools"]');
    expect(hideTools).not.toBeNull();
    await click(hideTools!);
    expect(document.body.textContent).not.toContain('apply_patch');

    await click(button('Reset replay'));
    expect(document.querySelector('input[aria-label="Replay position"]')?.getAttribute('value')).toBe('0');
  });

  it('opens raw supporting evidence from a selected Flow node', async () => {
    const run = traceRunFixture();
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'listRuns') return [{ id: run.id, title: run.title, startedAt: run.startedAt, updatedAt: run.endedAt, archived: false, status: run.status, warningCount: 0 }];
      if (method === 'loadRun') return run;
      if (method === 'loadRawEvidence') return { event: { type: 'function_call', name: 'apply_patch' }, truncated: false };
      throw new Error(`Unexpected method ${method}`);
    });
    await act(async () => panel.mount({ message: { request } }));

    const execute = document.querySelector<HTMLButtonElement>('button[aria-label^="Execute: apply_patch"]');
    expect(execute).not.toBeNull();
    await click(execute!);
    const toolNode = [...document.querySelectorAll('.flow-detail button')].find((item) =>
      item.querySelector('strong')?.textContent === 'apply_patch',
    );
    expect(toolNode).toBeInstanceOf(HTMLButtonElement);
    await click(toolNode as HTMLButtonElement);

    expect(document.querySelector('[aria-label="Evidence inspector"]')).not.toBeNull();
    expect(request).toHaveBeenCalledWith('@itharbors/traceweave-core', 'loadRawEvidence', {
      runId: 'run-1', eventId: 'event-3',
    });
    expect(document.body.textContent).toContain('function_call');
  });
});
