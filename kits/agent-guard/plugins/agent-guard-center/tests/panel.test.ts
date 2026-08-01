// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Agent Guard panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="guard-root"></div>';
    vi.resetModules();
  });
  afterEach(() => vi.useRealTimers());

  it('renders the Chinese dashboard while preserving technical identifiers', async () => {
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getSnapshot') return snapshot();
      if (method === 'getIncidents') return snapshot().incidents;
      throw new Error(`Unexpected ${method}`);
    });
    const panel = (await import('../panel.guard/src/index')).default;
    await panel.mount({ message: { request } });

    expect(document.querySelector('h1')?.textContent).toBe('本机智能体流量');
    expect(document.querySelector('[data-metric="bytes-out"]')?.textContent).toBe('12.0 MiB/min');
    expect(document.querySelector('[data-confidence]')?.textContent).toBe('已确认');
    expect(document.querySelector('.flow-lane')?.getAttribute('data-active')).toBe('true');
    expect(document.querySelector('[data-incident-id="incident-1"]')?.textContent).toContain('fixed-traffic-trip');
    expect(document.body.textContent).toContain('观测路由');
    expect(document.body.textContent).toContain('事件记录');
    expect(document.body.textContent).toContain('双重信号触发暂停');
    expect(document.body.textContent).toContain('仅采集本机连接元数据');
    expect(document.body.textContent).toContain('relay.example.test');
    expect(document.body.textContent).not.toContain('Local agent traffic');
    expect(document.body.textContent).not.toMatch(/request count|token cost/iu);
    panel.unmount();
  });

  it('renders Chinese loading copy while the first snapshot is pending', async () => {
    let release!: (value: unknown) => void;
    const request = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const panel = (await import('../panel.guard/src/index')).default;
    const mounting = panel.mount({ message: { request } });
    expect(document.body.textContent).toContain('正在启动本机流量监控');
    release(snapshot());
    await mounting;
    panel.unmount();
  });

  it('renders Chinese unavailable copy for an unknown failure', async () => {
    const request = vi.fn(async () => Promise.reject('offline'));
    const panel = (await import('../panel.guard/src/index')).default;
    await panel.mount({ message: { request } });
    expect(document.body.textContent).toContain('流量监控暂不可用');
    expect(document.querySelector('[data-action="retry"]')?.textContent).toBe('重试');
    panel.unmount();
  });

  it('keeps a localized failure heading while preserving an Error diagnostic', async () => {
    const request = vi.fn(async () => Promise.reject(new Error('Bridge disconnected')));
    const panel = (await import('../panel.guard/src/index')).default;
    await panel.mount({ message: { request } });
    expect(document.querySelector('h1')?.textContent).toBe('流量监控暂不可用');
    expect(document.querySelector('.state-detail')?.textContent).toBe('Bridge disconnected');
    panel.unmount();
  });

  it('explains in Chinese when no model endpoint is active', async () => {
    const idle = snapshot();
    idle.endpoints = [];
    const request = vi.fn(async () => idle);
    const panel = (await import('../panel.guard/src/index')).default;
    await panel.mount({ message: { request } });
    expect(document.body.textContent).toContain('当前没有活跃的 Claude 或 Codex 模型端点，后台监控仍在继续。');
    panel.unmount();
  });

  it('renders Chinese controls for a stopped incident', async () => {
    const request = vi.fn(async () => snapshot());
    const panel = (await import('../panel.guard/src/index')).default;
    await panel.mount({ message: { request } });
    const incident = document.querySelector('[data-incident-id="incident-1"]');
    expect(incident?.textContent).toContain('已暂停');
    expect(incident?.textContent).toContain('恢复任务');
    expect(incident?.textContent).toContain('结束任务');
    expect(incident?.textContent).toContain('忽略 15 分钟');
    panel.unmount();
  });

  it('distinguishes every incident state in the ledger', async () => {
    const value = snapshot();
    value.incidents = [
      { ...value.incidents[0], id: 'warning', state: 'warning' },
      { ...value.incidents[0], id: 'tripped', state: 'tripped' },
      { ...value.incidents[0], id: 'cooldown', state: 'cooldown' },
    ];
    const request = vi.fn(async () => value);
    const panel = (await import('../panel.guard/src/index')).default;
    await panel.mount({ message: { request } });
    expect(document.querySelector('[data-incident-id="warning"] .incident-marker')?.textContent).toBe('警告');
    expect(document.querySelector('[data-incident-id="tripped"] .incident-marker')?.textContent).toBe('已暂停');
    expect(document.querySelector('[data-incident-id="cooldown"] .incident-marker')?.textContent).toBe('冷却观察');
    panel.unmount();
  });

  it('keeps the route indicator still when both traffic rates are zero', async () => {
    const idle = snapshot();
    idle.endpoints[0].bytesInPerMinute = 0;
    idle.endpoints[0].bytesOutPerMinute = 0;
    const request = vi.fn(async () => idle);
    const panel = (await import('../panel.guard/src/index')).default;
    await panel.mount({ message: { request } });
    expect(document.querySelector('.flow-lane')?.getAttribute('data-active')).toBe('false');
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
    expect(request.mock.calls.filter((call) => call[1] === 'getSnapshot')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(request.mock.calls.filter((call) => call[1] === 'getSnapshot')).toHaveLength(2);
    panel.unmount();
    release!();
    await vi.advanceTimersByTimeAsync(4000);
    expect(request.mock.calls.filter((call) => call[1] === 'getSnapshot')).toHaveLength(2);
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

  it('localizes mutation failures and disables irrelevant autocomplete', async () => {
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getSnapshot') return snapshot();
      throw new Error('Policy bridge rejected the update');
    });
    const panel = (await import('../panel.guard/src/index')).default;
    await panel.mount({ message: { request } });
    expect(document.querySelector('input[name="warning-outbound"]')?.getAttribute('autocomplete')).toBe('off');
    document.querySelector<HTMLButtonElement>('[data-action="save-policy"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('h1')?.textContent).toBe('操作失败'));
    expect(document.querySelector('.state-detail')?.textContent).toBe('Policy bridge rejected the update');
    panel.unmount();
  });

  it('loads a 24-hour history once and distinguishes measured zero from missing coverage', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getSnapshot') return snapshot();
      if (method === 'getTrafficHistory') return historyResult();
      if (method === 'getHistoryStatus') return historyStatus();
      throw new Error(`Unexpected ${method}`);
    });
    const panel = (await import('../panel.guard/src/index')).default;
    await panel.mount({ message: { request } });

    expect(request).toHaveBeenCalledWith('@itharbors/agent-guard-center', 'getTrafficHistory', {
      from: NOW - 24 * 60 * 60_000,
      to: NOW,
      domain: 'network',
      agents: ['claude', 'codex'],
      hostnames: [],
      preferredBucket: 'minute',
    });
    expect(document.body.textContent).toContain('历史用量');
    await vi.waitFor(() => expect(document.body.textContent).toContain('实测网络流量'));
    expect(document.body.textContent).toContain('0 B');
    expect(document.body.textContent).toContain('未采集');
    expect(document.querySelectorAll('.history-chart path')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(request.mock.calls.filter((call) => call[1] === 'getTrafficHistory')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(26_000);
    expect(request.mock.calls.filter((call) => call[1] === 'getTrafficHistory')).toHaveLength(2);
    panel.unmount();
  });

  it('updates local backfill and requires a second action before clearing history', async () => {
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getSnapshot') return snapshot();
      if (method === 'getTrafficHistory') return historyResult();
      if (method === 'getHistoryStatus') return historyStatus();
      if (method === 'updateHistorySettings') return { ...historyStatus(), settings: { localSessionBackfill: false } };
      if (method === 'clearHistory') return { ...historyStatus(), generation: 4 };
      throw new Error(`Unexpected ${method}`);
    });
    const panel = (await import('../panel.guard/src/index')).default;
    await panel.mount({ message: { request } });

    await vi.waitFor(() => expect(document.querySelector('[data-action="toggle-backfill"]')).not.toBeNull());
    document.querySelector<HTMLButtonElement>('[data-action="toggle-backfill"]')!.click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
      '@itharbors/agent-guard-center', 'updateHistorySettings', { localSessionBackfill: false },
    ));
    document.querySelector<HTMLButtonElement>('[data-action="clear-history"]')!.click();
    expect(request.mock.calls.some((call) => call[1] === 'clearHistory')).toBe(false);
    document.querySelector<HTMLButtonElement>('[data-action="confirm-clear-history"]')!.click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
      '@itharbors/agent-guard-center', 'clearHistory', { confirmation: 'clear-history' },
    ));
    panel.unmount();
  });

  it('reloads history when the domain, range, or Agent filter changes', async () => {
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getSnapshot') return snapshot();
      if (method === 'getTrafficHistory') return historyResult();
      if (method === 'getHistoryStatus') return historyStatus();
      throw new Error(`Unexpected ${method}`);
    });
    const panel = (await import('../panel.guard/src/index')).default;
    await panel.mount({ message: { request } });
    await vi.waitFor(() => expect(document.querySelector('[data-action="history-agent-claude"]')).not.toBeNull());

    document.querySelector<HTMLButtonElement>('[data-action="history-domain-model-usage"]')!.click();
    await vi.waitFor(() => expect(request.mock.calls.some((call) => (
      call[1] === 'getTrafficHistory' && (call[2] as { domain?: string }).domain === 'model-usage'
    ))).toBe(true));
    document.querySelector<HTMLButtonElement>('[data-action="history-range-7d"]')!.click();
    await vi.waitFor(() => expect(request.mock.calls.some((call) => (
      call[1] === 'getTrafficHistory' && (call[2] as { preferredBucket?: string }).preferredBucket === 'hour'
    ))).toBe(true));
    document.querySelector<HTMLButtonElement>('[data-action="history-agent-claude"]')!.click();
    await vi.waitFor(() => expect(request.mock.calls.some((call) => (
      call[1] === 'getTrafficHistory' && JSON.stringify((call[2] as { agents?: string[] }).agents) === '["claude"]'
    ))).toBe(true));
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
const NOW = Date.parse('2026-08-01T08:00:00.000Z');

function historyResult() {
  return {
    schemaVersion: 1,
    domain: 'network',
    from: NOW - 24 * 60 * 60_000,
    to: NOW,
    actualBucket: 'minute',
    generation: 3,
    persistent: false,
    series: [{
      metric: 'bytes-out', unit: 'bytes', agent: 'claude', provider: 'custom', hostname: 'relay.example.test',
      points: [{
        start: NOW - 120_000, end: NOW - 60_000, value: 0, coverage: 'complete', coverageReason: null,
        provenance: 'network-sample', quality: 'measured',
      }, {
        start: NOW - 60_000, end: NOW, value: null, coverage: 'missing', coverageReason: 'collector-stopped',
        provenance: null, quality: null,
      }],
    }],
    summary: [{ metric: 'bytes-out', unit: 'bytes', value: 0, coverageRatio: 0.5, derivedRatio: 0 }],
    sources: [{ provenance: 'network-sample', quality: 'measured', pointCount: 1 }],
    warnings: ['partial-collector-coverage'],
  };
}

function historyStatus() {
  return {
    schemaVersion: 1,
    persistent: false,
    storageBytes: 2048,
    earliestAt: NOW - 24 * 60 * 60_000,
    latestAt: NOW,
    generation: 3,
    lastCompactedAt: NOW - 60_000,
    lastBackfilledAt: NOW - 120_000,
    settings: { localSessionBackfill: true },
    warnings: [],
  };
}
