import fs from 'node:fs';
import path from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FlowOverview } from '../panel.trace/src/flow-overview.js';
import { Inspector } from '../panel.trace/src/inspector.js';
import { traceRunFixture } from './fixtures.js';

const sourceRoot = path.resolve('plugins/traceweave-view/panel.trace/src');

describe('TraceWeave accessibility contracts', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); });

  it('uses native controls with programmatic stage expansion', async () => {
    await act(async () => root.render(<FlowOverview run={traceRunFixture()} onSelectNode={() => {}} />));
    const execute = container.querySelector<HTMLButtonElement>('button[aria-label^="Execute:"]');
    expect(execute).not.toBeNull();
    expect(execute?.getAttribute('aria-expanded')).toBe('false');
    expect(execute?.getAttribute('aria-controls')).toBe('turn-1-execute-details');
    await act(async () => execute?.click());
    expect(execute?.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById('turn-1-execute-details')).not.toBeNull();
  });

  it('closes the evidence inspector with Escape and restores originating focus', async () => {
    const origin = document.createElement('button');
    origin.textContent = 'origin';
    document.body.prepend(origin);
    origin.focus();
    const onClose = vi.fn();
    const run = traceRunFixture();
    const node = run.turns[0].nodes[2];
    const api = { loadRawEvidence: vi.fn(async () => ({ event: {}, truncated: false })) } as any;
    await act(async () => root.render(<Inspector runId={run.id} node={node} api={api} onClose={onClose} />));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
    expect(document.activeElement).toBe(origin);
    root = createRoot(container);
  });

  it('declares visible focus, bounded viewport, reduced motion and responsive rules', () => {
    const css = fs.readFileSync(path.join(sourceRoot, 'index.css'), 'utf8');
    expect(css).toMatch(/button:focus-visible/);
    expect(css).toMatch(/body\s*\{[^}]*overflow:\s*hidden/s);
    expect(css).toMatch(/\.flow-stage\s*>\s*button[^}]*min-height:\s*(?:[4-9]\d|\d{3,})px/s);
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    expect(css).toMatch(/@media\s*\(max-width:\s*980px\)/);
    expect(css).toMatch(/\.inspector\s*>\s*header\s*\{[^}]*min-width:\s*0/s);
    expect(css).toMatch(/\.inspector\s*>\s*header\s*>\s*div\s*\{[^}]*min-width:\s*0/s);
    expect(css).toMatch(/\.inspector\s*>\s*header\s+h2\s*\{[^}]*text-overflow:\s*ellipsis/s);
  });
});
