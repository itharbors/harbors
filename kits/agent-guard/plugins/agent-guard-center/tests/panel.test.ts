// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Agent Guard panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="guard-root"></div>';
    vi.resetModules();
  });
  afterEach(() => vi.useRealTimers());

  it('renders exact traffic semantics, confidence, incidents, and privacy boundary', async () => {
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getSnapshot') return snapshot();
      if (method === 'getIncidents') return snapshot().incidents;
      throw new Error(`Unexpected ${method}`);
    });
    const panel = (await import('../panel.guard/src/index')).default;
    await panel.mount({ message: { request } });

    expect(document.querySelector('h1')?.textContent).toBe('Local agent traffic');
    expect(document.querySelector('[data-metric="bytes-out"]')?.textContent).toBe('12.0 MiB/min');
    expect(document.querySelector('[data-confidence]')?.textContent).toBe('Confirmed');
    expect(document.querySelector('[data-incident-id="incident-1"]')?.textContent).toContain('fixed-traffic-trip');
    expect(document.body.textContent).toContain('Prompts, responses, credentials, and exact request totals are never collected.');
    expect(document.body.textContent).not.toMatch(/request count|token cost/iu);
    panel.unmount();
  });

  it('coalesces polling and stops all polling after unmount', async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const request = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return snapshot();
    });
    const panel = (await import('../panel.guard/src/index')).default;
    const mounting = panel.mount({ message: { request } });
    release!();
    await mounting;
    await vi.advanceTimersByTimeAsync(2000);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(request).toHaveBeenCalledTimes(2);
    panel.unmount();
    release!();
    await vi.advanceTimersByTimeAsync(4000);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('serializes policy changes through the center bridge', async () => {
    const request = vi.fn(async (_plugin: string, method: string) => method === 'getSnapshot' ? snapshot() : undefined);
    const panel = (await import('../panel.guard/src/index')).default;
    await panel.mount({ message: { request } });
    const warning = document.querySelector<HTMLInputElement>('input[name="warning-outbound"]')!;
    warning.value = '256';
    document.querySelector<HTMLButtonElement>('[data-action="save-policy"]')!.click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
      '@itharbors/agent-guard-center',
      'updatePolicy',
      expect.objectContaining({ fixedWarning: { outboundMiB: 256, sessionsOrTasks: 20 } }),
    ));
    panel.unmount();
  });
});

function snapshot() {
  return {
    schemaVersion: 1, observedAt: 1_754_000_000_000, state: 'tripped',
    collector: { status: 'running', epoch: 3, lastObservedAt: 1_754_000_000_000, incomplete: false },
    endpoints: [{
      agent: 'claude', provider: 'custom', hostname: 'relay.example.test', confidence: 'confirmed',
      bytesIn: 8 * MIB, bytesOut: 20 * MIB, bytesInPerMinute: 4 * MIB,
      bytesOutPerMinute: 12 * MIB, connections: 3, activeTasks: 2,
    }],
    incidents: [{
      id: 'incident-1', openedAt: 1_754_000_000_000, updatedAt: 1_754_000_000_000,
      agent: 'claude', provider: 'custom', hostname: 'relay.example.test', state: 'tripped',
      ruleId: 'fixed-traffic-trip', confidence: 'confirmed', summary: 'Outbound traffic stayed abnormal',
    }],
  };
}

const MIB = 1024 * 1024;
