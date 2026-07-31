import type { RunSummary } from '@itharbors/traceweave-contracts';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunRail } from '../panel.trace/src/run-rail.js';

function run(id: string, title: string, archived: boolean): RunSummary {
  return {
    id,
    title,
    archived,
    startedAt: '2026-07-31T08:00:00.000Z',
    updatedAt: '2026-07-31T08:01:00.000Z',
    status: 'complete',
    warningCount: 0,
  };
}

describe('TraceWeave run rail', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
  });

  it('shows active sessions and keeps archived sessions collapsed until requested', async () => {
    const onSelect = vi.fn();
    const runs = [
      run('active-1', 'Current task', false),
      run('active-2', 'Another task', false),
      run('archived-1', 'Archived task', true),
    ];
    await act(async () => root.render(
      <RunRail runs={runs} selectedId="active-1" onSelect={onSelect} />,
    ));

    const activeToggle = container.querySelector<HTMLButtonElement>('[aria-label="Active sessions, 2"]');
    const archivedToggle = container.querySelector<HTMLButtonElement>('[aria-label="Archived sessions, 1"]');
    expect(activeToggle?.getAttribute('aria-expanded')).toBe('true');
    expect(archivedToggle?.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).toContain('Current task');
    expect(container.textContent).not.toContain('Archived task');
    const currentSession = [...container.querySelectorAll<HTMLButtonElement>('li button')]
      .find(button => button.textContent?.includes('Current task'));
    expect(archivedToggle?.compareDocumentPosition(currentSession!)! & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();

    await act(async () => archivedToggle?.click());

    expect(archivedToggle?.getAttribute('aria-expanded')).toBe('true');
    const archivedSession = [...container.querySelectorAll<HTMLButtonElement>('li button')]
      .find(button => button.textContent?.includes('Archived task'));
    expect(archivedSession).toBeInstanceOf(HTMLButtonElement);
    await act(async () => archivedSession?.click());
    expect(onSelect).toHaveBeenCalledWith('archived-1');
  });

  it('automatically reveals the selected archived session', async () => {
    await act(async () => root.render(
      <RunRail
        runs={[run('active-1', 'Current task', false), run('archived-1', 'Archived task', true)]}
        selectedId="archived-1"
        onSelect={() => {}}
      />,
    ));

    expect(container.querySelector('[aria-label="Archived sessions, 1"]')?.getAttribute('aria-expanded'))
      .toBe('true');
    expect(container.querySelector('button[aria-current="true"]')?.textContent).toContain('Archived task');
  });
});
