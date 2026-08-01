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
    expect(document.body.textContent).toContain('观测路由');
    expect(document.querySelector('[data-incident-id]')).toBeNull();
    expect(document.body.textContent).not.toContain('双重信号触发暂停');
    expect(document.body.textContent).not.toContain('仅采集本机连接元数据');
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
    document.querySelector<HTMLButtonElement>('[role="tab"][data-tab="incidents"]')!.click();
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
    document.querySelector<HTMLButtonElement>('[role="tab"][data-tab="incidents"]')!.click();
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
    document.querySelector<HTMLButtonElement>('[role="tab"][data-tab="settings"]')!.click();
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

  it('keeps a failed policy mutation inline and retryable without losing settings workspace state', async () => {
    let updateAttempts = 0;
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getSnapshot') return snapshot();
      if (method === 'getTrafficHistory') return historyResult();
      if (method === 'getHistoryStatus') return historyStatus();
      if (method === 'updatePolicy') {
        updateAttempts += 1;
        if (updateAttempts === 1) throw new Error('Policy bridge rejected the update');
        return undefined;
      }
      throw new Error(`Unexpected ${method}`);
    });
    const panel = (await import('../panel.guard/src/index')).default;
    await panel.mount({ message: { request } });
    document.querySelector<HTMLButtonElement>('[role="tab"][data-tab="settings"]')!.click();
    const warning = document.querySelector<HTMLInputElement>('input[name="warning-outbound"]')!;
    expect(warning.getAttribute('autocomplete')).toBe('off');
    warning.value = '256';
    warning.focus();
    document.querySelector<HTMLButtonElement>('[data-action="save-policy"]')!.click();

    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('Policy bridge rejected the update'));
    expect(document.querySelector('h1')?.textContent).toBe('本机智能体流量');
    expect(document.querySelector('[role="tab"][data-tab="settings"]')?.getAttribute('aria-selected')).toBe('true');
    const restoredWarning = document.querySelector<HTMLInputElement>('input[name="warning-outbound"]')!;
    expect(restoredWarning.value).toBe('256');
    expect(document.activeElement).toBe(restoredWarning);

    document.querySelector<HTMLButtonElement>('[data-action="save-policy"]')!.click();
    await vi.waitFor(() => expect(updateAttempts).toBe(2));
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).toBeNull());
    expect(document.querySelector('[role="tab"][data-tab="settings"]')?.getAttribute('aria-selected')).toBe('true');
    panel.unmount();
  });

  it('merges all Agent history into two metric trend lines', async () => {
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
    await vi.waitFor(() => expect(document.querySelectorAll('.agent-history-row')).toHaveLength(2));
    expect(document.body.textContent).toContain('未采集');
    expect(document.querySelector('[data-action="history-agent-claude"]')).toBeNull();
    expect(document.querySelector('[data-action="history-agent-codex"]')).toBeNull();
    expect(document.querySelectorAll('.history-chart path')).toHaveLength(2);
    expect(document.querySelector('.route-metrics [data-metric="bytes-out"]')?.getAttribute('data-values')).toBeNull();
    expect(document.querySelector('.history-chart path[data-metric="bytes-in"]')?.getAttribute('data-values')).toBe('3072,null');
    expect(document.querySelector('.history-chart path[data-metric="bytes-out"]')?.getAttribute('data-values')).toBe('1536,0');
    expect(document.querySelector('[data-history-agent="claude"]')?.textContent).toContain('Claude');
    expect(document.querySelector('[data-history-agent="codex"]')?.textContent).toContain('Codex');

    await vi.advanceTimersByTimeAsync(4_000);
    expect(request.mock.calls.filter((call) => call[1] === 'getTrafficHistory')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(26_000);
    expect(request.mock.calls.filter((call) => call[1] === 'getTrafficHistory')).toHaveLength(2);
    panel.unmount();
  });

  it('renders independent Agent history rows with a real local-time axis', async () => {
    const request = vi.fn(async (_plugin: string, method: string, input?: { domain?: 'network' | 'model-usage' }) => {
      if (method === 'getSnapshot') return snapshot();
      if (method === 'getTrafficHistory') return input?.domain === 'model-usage'
        ? modelHistoryResult()
        : agentSummaryHistoryResult();
      if (method === 'getHistoryStatus') return historyStatus();
      throw new Error(`Unexpected ${method}`);
    });
    const panel = (await import('../panel.guard/src/index')).default;
    await panel.mount({ message: { request } });

    await vi.waitFor(() => expect(document.querySelector('[data-history-agent="claude"] [data-metric="bytes-in"]')).not.toBeNull());
    expect(document.querySelector('[data-history-agent="claude"] [data-metric="bytes-in"]')?.textContent).toContain('300 B');
    expect(document.querySelector('[data-history-agent="claude"] [data-metric="bytes-out"]')?.textContent).toContain('未采集');
    expect(document.querySelector('[data-history-agent="codex"] [data-metric="bytes-in"]')?.textContent).toContain('0 B');
    expect(document.querySelectorAll('.history-axis-tick')).toHaveLength(5);
    expect(document.querySelector('.history-axis-title')?.textContent).toBe('时间（本地时区）');
    expect(document.querySelector('.history-chart svg')?.getAttribute('preserveAspectRatio')).toBe('none');
    expect(document.querySelectorAll('.history-chart path')).toHaveLength(2);

    document.querySelector<HTMLButtonElement>('[data-action="history-domain-model-usage"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-history-agent="claude"] [data-metric="input-tokens"]')).not.toBeNull());
    for (const agent of ['claude', 'codex']) {
      expect([...document.querySelectorAll(`[data-history-agent="${agent}"] [data-metric]`)].map((item) => item.getAttribute('data-metric')))
        .toEqual(['input-tokens', 'output-tokens', 'cache-tokens', 'requests', 'sessions']);
    }
    expect(document.querySelectorAll('.history-chart path')).toHaveLength(2);
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

    document.querySelector<HTMLButtonElement>('[role="tab"][data-tab="settings"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('#settings-panel [data-action="toggle-backfill"]')).not.toBeNull());
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

  it('keeps rejected backfill changes local to Settings without replacing overview history', async () => {
    let updateAttempts = 0;
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getSnapshot') return snapshot();
      if (method === 'getTrafficHistory') return historyResult();
      if (method === 'getHistoryStatus') return historyStatus();
      if (method === 'updateHistorySettings') {
        updateAttempts += 1;
        if (updateAttempts === 1) throw new Error('Backfill bridge rejected the update');
        return { ...historyStatus(), settings: { localSessionBackfill: false } };
      }
      throw new Error(`Unexpected ${method}`);
    });
    const panel = (await import('../panel.guard/src/index')).default;
    await panel.mount({ message: { request } });
    await vi.waitFor(() => expect(document.querySelectorAll('.agent-history-row')).toHaveLength(2));

    document.querySelector<HTMLButtonElement>('[role="tab"][data-tab="settings"]')!.click();
    const toggle = document.querySelector<HTMLButtonElement>('[data-action="toggle-backfill"]')!;
    toggle.focus();
    toggle.click();

    await vi.waitFor(() => expect(document.querySelector('#settings-panel [data-history-management-error]')?.textContent)
      .toContain('Backfill bridge rejected the update'));
    expect(document.querySelector<HTMLButtonElement>('[role="tab"][data-tab="settings"]')?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(document.querySelector('[data-action="toggle-backfill"]'));

    document.querySelector<HTMLButtonElement>('[role="tab"][data-tab="overview"]')!.click();
    expect(document.querySelectorAll('.agent-history-row')).toHaveLength(2);

    document.querySelector<HTMLButtonElement>('[role="tab"][data-tab="settings"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-action="toggle-backfill"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-history-management-error]')).toBeNull());
    panel.unmount();
  });

  it('keeps clear confirmation and focus when clearing history is rejected in Settings', async () => {
    let clearAttempts = 0;
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getSnapshot') return snapshot();
      if (method === 'getTrafficHistory') return historyResult();
      if (method === 'getHistoryStatus') return historyStatus();
      if (method === 'clearHistory') {
        clearAttempts += 1;
        if (clearAttempts === 1) throw new Error('Clear bridge rejected the request');
        return { ...historyStatus(), generation: 4 };
      }
      throw new Error(`Unexpected ${method}`);
    });
    const panel = (await import('../panel.guard/src/index')).default;
    await panel.mount({ message: { request } });
    await vi.waitFor(() => expect(document.querySelectorAll('.agent-history-row')).toHaveLength(2));

    document.querySelector<HTMLButtonElement>('[role="tab"][data-tab="settings"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-action="clear-history"]')!.click();
    const confirm = document.querySelector<HTMLButtonElement>('[data-action="confirm-clear-history"]')!;
    confirm.focus();
    confirm.click();

    await vi.waitFor(() => expect(document.querySelector('#settings-panel [data-history-management-error]')?.textContent)
      .toContain('Clear bridge rejected the request'));
    expect(document.querySelector<HTMLButtonElement>('[role="tab"][data-tab="settings"]')?.getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('[data-action="confirm-clear-history"]')).not.toBeNull();
    expect(document.querySelector('[data-action="cancel-clear-history"]')).not.toBeNull();
    expect(document.activeElement).toBe(document.querySelector('[data-action="confirm-clear-history"]'));

    document.querySelector<HTMLButtonElement>('[data-action="confirm-clear-history"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-history-management-error]')).toBeNull());
    panel.unmount();
  });

  it('renders no-record cache labels instead of epoch dates for an empty history', async () => {
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getSnapshot') return snapshot();
      if (method === 'getTrafficHistory') return historyResult();
      if (method === 'getHistoryStatus') return { ...historyStatus(), earliestAt: null, latestAt: null };
      throw new Error(`Unexpected ${method}`);
    });
    const panel = (await import('../panel.guard/src/index')).default;
    await panel.mount({ message: { request } });
    document.querySelector<HTMLButtonElement>('[role="tab"][data-tab="settings"]')!.click();

    await vi.waitFor(() => expect(document.querySelector('#settings-panel .cache-status')?.textContent).toContain('最早记录 暂无记录'));
    const cacheStatus = document.querySelector('#settings-panel .cache-status')?.textContent;
    expect(cacheStatus).toContain('最新记录 暂无记录');
    expect(cacheStatus).not.toContain('1970');
    panel.unmount();
  });

  it('reloads history when the domain or range changes while keeping both Agents', async () => {
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getSnapshot') return snapshot();
      if (method === 'getTrafficHistory') return historyResult();
      if (method === 'getHistoryStatus') return historyStatus();
      throw new Error(`Unexpected ${method}`);
    });
    const panel = (await import('../panel.guard/src/index')).default;
    await panel.mount({ message: { request } });
    await vi.waitFor(() => expect(document.querySelector('[data-action="history-range-7d"]')).not.toBeNull());
    expect(document.querySelector('[data-action="history-agent-claude"]')).toBeNull();
    expect(document.querySelector('[data-action="history-agent-codex"]')).toBeNull();

    document.querySelector<HTMLButtonElement>('[data-action="history-domain-model-usage"]')!.click();
    await vi.waitFor(() => expect(request.mock.calls.some((call) => (
      call[1] === 'getTrafficHistory' && (call[2] as { domain?: string }).domain === 'model-usage'
    ))).toBe(true));
    document.querySelector<HTMLButtonElement>('[data-action="history-range-7d"]')!.click();
    await vi.waitFor(() => expect(request.mock.calls.some((call) => (
      call[1] === 'getTrafficHistory' && (call[2] as { preferredBucket?: string }).preferredBucket === 'hour'
    ))).toBe(true));
    expect(request.mock.calls.filter((call) => call[1] === 'getTrafficHistory').every((call) => (
      JSON.stringify((call[2] as { agents?: string[] }).agents) === '["claude","codex"]'
    ))).toBe(true);
    panel.unmount();
  });

  it('does not render a previous history query while a new domain request is pending and snapshots keep polling', async () => {
    vi.useFakeTimers();
    let snapshotRequests = 0;
    let releaseModelHistory: ((value: unknown) => void) | undefined;
    const request = vi.fn(async (_plugin: string, method: string, input?: { domain?: string }) => {
      if (method === 'getSnapshot') {
        snapshotRequests += 1;
        return { ...snapshot(), observedAt: snapshot().observedAt + snapshotRequests };
      }
      if (method === 'getTrafficHistory') {
        if (input?.domain === 'model-usage') {
          return new Promise((resolve) => { releaseModelHistory = resolve; });
        }
        return historyResult();
      }
      if (method === 'getHistoryStatus') return historyStatus();
      throw new Error(`Unexpected ${method}`);
    });
    const panel = (await import('../panel.guard/src/index')).default;
    await panel.mount({ message: { request } });

    await vi.waitFor(() => expect(document.querySelector('.history-chart path[data-metric="bytes-in"]')).not.toBeNull());
    document.querySelector<HTMLButtonElement>('[data-action="history-domain-model-usage"]')!.click();
    await vi.waitFor(() => expect(releaseModelHistory).toBeTypeOf('function'));

    try {
      await vi.advanceTimersByTimeAsync(2_000);
      expect(document.querySelector('[data-action="history-domain-model-usage"]')?.getAttribute('aria-pressed')).toBe('true');
      const loading = document.querySelector('.history-message');
      expect(loading).not.toBeNull();
      expect(loading!.textContent).toContain('正在读取历史数据');
      expect(document.querySelector('.history-chart path[data-metric="bytes-in"]')).toBeNull();
    } finally {
      releaseModelHistory?.(modelHistoryResult());
      await Promise.resolve();
      panel.unmount();
    }
  });

  it('renders every fixed history metric as uncollected when the response omits all series and summaries', async () => {
    const request = vi.fn(async (_plugin: string, method: string, input?: { domain?: 'network' | 'model-usage' }) => {
      if (method === 'getSnapshot') return snapshot();
      if (method === 'getTrafficHistory') return emptyHistoryResult(input?.domain ?? 'network');
      if (method === 'getHistoryStatus') return historyStatus();
      throw new Error(`Unexpected ${method}`);
    });
    const panel = (await import('../panel.guard/src/index')).default;
    await panel.mount({ message: { request } });

    await vi.waitFor(() => expect(document.querySelectorAll('.history-chart path[data-metric]')).toHaveLength(2));
    expect([...document.querySelectorAll('.history-chart path[data-metric]')].map((item) => item.getAttribute('data-values')))
      .toEqual(['', '']);
    expect(document.querySelectorAll('.history-stat')).toHaveLength(4);
    expect([...document.querySelectorAll('.history-stat')].every((item) => (
      item.textContent?.includes('未采集') && item.textContent.includes('覆盖 0%')
    ))).toBe(true);

    document.querySelector<HTMLButtonElement>('[data-action="history-domain-model-usage"]')!.click();
    await vi.waitFor(() => expect(document.querySelectorAll('.history-stat')).toHaveLength(10));
    expect(document.querySelectorAll('.history-chart path[data-metric]')).toHaveLength(2);
    expect([...document.querySelectorAll('.history-stat')].every((item) => (
      item.textContent?.includes('未采集') && item.textContent.includes('覆盖 0%')
    ))).toBe(true);
    panel.unmount();
  });

  it('shows only token trends and displays every model metric for each Agent', async () => {
    const request = vi.fn(async (_plugin: string, method: string, input?: { domain?: string }) => {
      if (method === 'getSnapshot') return snapshot();
      if (method === 'getTrafficHistory') return input?.domain === 'model-usage' ? modelHistoryResult() : historyResult();
      if (method === 'getHistoryStatus') return historyStatus();
      throw new Error(`Unexpected ${method}`);
    });
    const panel = (await import('../panel.guard/src/index')).default;
    await panel.mount({ message: { request } });

    document.querySelector<HTMLButtonElement>('[data-action="history-domain-model-usage"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-metric="input-tokens"]')).not.toBeNull());

    expect(document.querySelectorAll('.history-chart path')).toHaveLength(2);
    for (const agent of ['claude', 'codex']) {
      expect([...document.querySelectorAll(`[data-history-agent="${agent}"] [data-metric]`)].map((item) => item.getAttribute('data-metric')))
        .toEqual(['input-tokens', 'output-tokens', 'cache-tokens', 'requests', 'sessions']);
    }
    panel.unmount();
  });

  it('separates overview, incidents, and settings ownership', async () => {
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getSnapshot') return snapshot();
      if (method === 'getTrafficHistory') return historyResult();
      if (method === 'getHistoryStatus') return historyStatus();
      throw new Error(`Unexpected ${method}`);
    });
    const panel = (await import('../panel.guard/src/index')).default;
    await panel.mount({ message: { request } });

    expect([...document.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => tab.dataset.tab)).toEqual([
      'overview', 'incidents', 'settings',
    ]);
    const overview = document.querySelector<HTMLButtonElement>('[role="tab"][data-tab="overview"]')!;
    const incidents = document.querySelector<HTMLButtonElement>('[role="tab"][data-tab="incidents"]')!;
    expect(overview.getAttribute('aria-selected')).toBe('true');
    expect(overview.getAttribute('aria-controls')).toBe('overview-panel');
    const overviewPanel = document.querySelector('#overview-panel');
    expect(overviewPanel).not.toBeNull();
    expect(overviewPanel?.hasAttribute('hidden')).toBe(false);
    expect(document.querySelectorAll('.dashboard-content [role="tabpanel"]')).toHaveLength(1);
    expect(document.querySelector('#incidents-panel')).toBeNull();
    expect(document.querySelector('[data-incident-id]')).toBeNull();
    expect(document.querySelector('.policy-panel')).toBeNull();
    expect(overviewPanel?.querySelector('[data-action="toggle-backfill"]')).toBeNull();
    expect(overviewPanel?.querySelector('[data-action="clear-history"]')).toBeNull();
    expect(incidents.textContent).toContain('1');
    expect(incidents.getAttribute('aria-controls')).toBe('incidents-panel');

    incidents.click();
    expect(incidents.getAttribute('aria-selected')).toBe('true');
    const incidentsPanel = document.querySelector('#incidents-panel');
    expect(incidentsPanel?.hasAttribute('hidden')).toBe(false);
    expect(document.querySelector('#overview-panel')).toBeNull();
    expect(incidentsPanel?.querySelector('[data-incident-id="incident-1"]')).not.toBeNull();
    expect(incidentsPanel?.querySelector('.policy-panel')).toBeNull();

    document.querySelector<HTMLButtonElement>('[role="tab"][data-tab="settings"]')!.click();
    const settingsPanel = document.querySelector('#settings-panel');
    expect([...settingsPanel!.querySelectorAll<HTMLElement>('.settings-section')].map((section) => section.querySelector('h2')?.textContent))
      .toEqual(['保护策略', '历史采集', '缓存管理', '隐私说明']);
    expect(settingsPanel?.querySelector('.policy-panel')).not.toBeNull();
    expect(settingsPanel?.querySelector('[data-action="toggle-backfill"]')).not.toBeNull();
    expect(settingsPanel?.querySelector('[data-action="clear-history"]')).not.toBeNull();
    expect(settingsPanel?.querySelector('.privacy-note')).not.toBeNull();
    panel.unmount();
  });

  it('marks all Tabs generically and gives the incident badge an explicit count state', async () => {
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getSnapshot') return snapshot();
      if (method === 'getTrafficHistory') return historyResult();
      if (method === 'getHistoryStatus') return historyStatus();
      throw new Error(`Unexpected ${method}`);
    });
    const panel = (await import('../panel.guard/src/index')).default;
    await panel.mount({ message: { request } });

    const overview = document.querySelector<HTMLButtonElement>('[role="tab"][data-tab="overview"]')!;
    const incidents = document.querySelector<HTMLButtonElement>('[role="tab"][data-tab="incidents"]')!;
    const settings = document.querySelector<HTMLButtonElement>('[role="tab"][data-tab="settings"]')!;
    expect(overview.classList.contains('dashboard-tab')).toBe(true);
    expect(incidents.classList.contains('dashboard-tab')).toBe(true);
    expect(settings.classList.contains('dashboard-tab')).toBe(true);
    const badge = incidents.querySelector<HTMLElement>('.dashboard-tab-badge');
    expect(badge?.textContent).toBe('1');
    expect(badge?.dataset.state).toBe('nonzero');
    panel.unmount();

    const empty = snapshot();
    empty.incidents = [];
    const emptyRequest = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getSnapshot') return empty;
      if (method === 'getTrafficHistory') return historyResult();
      if (method === 'getHistoryStatus') return historyStatus();
      throw new Error(`Unexpected ${method}`);
    });
    await panel.mount({ message: { request: emptyRequest } });

    const emptyBadge = document.querySelector<HTMLElement>('[role="tab"][data-tab="incidents"] .dashboard-tab-badge');
    expect(emptyBadge?.textContent).toBe('0');
    expect(emptyBadge?.dataset.state).toBe('zero');
    panel.unmount();
  });

  it('uses wrapped ARIA Tabs keyboard navigation', async () => {
    const request = vi.fn(async (_plugin: string, method: string) => method === 'getSnapshot' ? snapshot() : historyResult());
    const panel = (await import('../panel.guard/src/index')).default;
    await panel.mount({ message: { request } });

    const tab = () => document.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!;
    tab().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(tab().dataset.tab).toBe('settings');
    expect(document.activeElement).toBe(tab());
    tab().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(tab().dataset.tab).toBe('overview');
    tab().dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(tab().dataset.tab).toBe('settings');
    tab().dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(tab().dataset.tab).toBe('overview');
    const inactiveIncidents = document.querySelector<HTMLButtonElement>('[role="tab"][data-tab="incidents"]')!;
    inactiveIncidents.focus();
    inactiveIncidents.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(tab().dataset.tab).toBe('incidents');
    const inactiveOverview = document.querySelector<HTMLButtonElement>('[role="tab"][data-tab="overview"]')!;
    inactiveOverview.focus();
    inactiveOverview.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(tab().dataset.tab).toBe('overview');
    panel.unmount();
  });

  it('navigates relative to the focused inactive Tab', async () => {
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getSnapshot') return snapshot();
      if (method === 'getTrafficHistory') return historyResult();
      if (method === 'getHistoryStatus') return historyStatus();
      throw new Error(`Unexpected ${method}`);
    });
    const panel = (await import('../panel.guard/src/index')).default;
    await panel.mount({ message: { request } });

    const incidents = document.querySelector<HTMLButtonElement>('[role="tab"][data-tab="incidents"]')!;
    incidents.focus();
    incidents.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

    const settings = document.querySelector<HTMLButtonElement>('[role="tab"][data-tab="settings"]')!;
    expect(settings.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(settings);
    panel.unmount();
  });

  it('preserves settings Tab state, policy drafts, focused management controls, and scroll through polling', async () => {
    vi.useFakeTimers();
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    Object.defineProperties(window, {
      scrollX: { configurable: true, value: 18 },
      scrollY: { configurable: true, value: 240 },
    });
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getSnapshot') return snapshot();
      if (method === 'getTrafficHistory') return historyResult();
      if (method === 'getHistoryStatus') return historyStatus();
      throw new Error(`Unexpected ${method}`);
    });
    const panel = (await import('../panel.guard/src/index')).default;
    await panel.mount({ message: { request } });

    const settings = document.querySelector<HTMLButtonElement>('[role="tab"][data-tab="settings"]')!;
    settings.click();
    document.querySelector<HTMLInputElement>('input[name="warning-outbound"]')!.value = '256';
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-action="toggle-backfill"]')?.disabled).toBe(false));
    const toggleBackfill = document.querySelector<HTMLButtonElement>('[data-action="toggle-backfill"]')!;
    toggleBackfill.focus();
    await vi.advanceTimersByTimeAsync(2_000);

    const active = document.querySelector<HTMLButtonElement>('[role="tab"][data-tab="settings"]')!;
    expect(active.getAttribute('aria-selected')).toBe('true');
    expect((document.activeElement as HTMLElement).dataset.action).toBe('toggle-backfill');
    expect(document.querySelector<HTMLInputElement>('input[name="warning-outbound"]')!.value).toBe('256');
    expect(scrollTo).toHaveBeenCalledWith(18, 240);
    panel.unmount();
  });

  it('restores focus to the same incident action when multiple incidents rerender during polling', async () => {
    vi.useFakeTimers();
    const value = snapshot();
    value.incidents.push({
      ...value.incidents[0],
      id: 'incident-2',
      openedAt: value.incidents[0].openedAt + 1,
      updatedAt: value.incidents[0].updatedAt + 1,
    });
    let snapshotRequests = 0;
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getSnapshot') {
        snapshotRequests += 1;
        return { ...value, observedAt: value.observedAt + snapshotRequests };
      }
      if (method === 'getTrafficHistory') return historyResult();
      if (method === 'getHistoryStatus') return historyStatus();
      throw new Error(`Unexpected ${method}`);
    });
    const panel = (await import('../panel.guard/src/index')).default;
    await panel.mount({ message: { request } });
    await vi.waitFor(() => expect(request.mock.calls.some((call) => call[1] === 'getTrafficHistory')).toBe(true));
    await Promise.resolve();

    document.querySelector<HTMLButtonElement>('[role="tab"][data-tab="incidents"]')!.click();
    const firstIncidentIgnore = document.querySelector<HTMLButtonElement>('[data-incident-id="incident-1"] [data-action="ignore"]')!;
    firstIncidentIgnore.focus();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(document.activeElement?.closest<HTMLElement>('[data-incident-id]')?.dataset.incidentId).toBe('incident-1');
    expect((document.activeElement as HTMLElement).dataset.action).toBe('ignore');
    panel.unmount();
  });

  it('positions unequal history coverage by timestamp against the shared query range', async () => {
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getSnapshot') return snapshot();
      if (method === 'getTrafficHistory') return positionedHistoryResult();
      if (method === 'getHistoryStatus') return historyStatus();
      throw new Error(`Unexpected ${method}`);
    });
    const panel = (await import('../panel.guard/src/index')).default;
    await panel.mount({ message: { request } });

    await vi.waitFor(() => expect(document.querySelector('.history-chart path[data-metric="bytes-out"]')).not.toBeNull());
    expect(document.querySelector('.history-chart path[data-metric="bytes-in"]')?.getAttribute('d'))
      .toBe('M10.0,92.5 L360.0,20.0');
    expect(document.querySelector('.history-chart path[data-metric="bytes-out"]')?.getAttribute('d'))
      .toBe('M360.0,128.8');
    panel.unmount();
  });

  it('breaks a history line when an entire bucket object is missing', async () => {
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getSnapshot') return snapshot();
      if (method === 'getTrafficHistory') return historyWithMissingBucketObject();
      if (method === 'getHistoryStatus') return historyStatus();
      throw new Error(`Unexpected ${method}`);
    });
    const panel = (await import('../panel.guard/src/index')).default;
    await panel.mount({ message: { request } });

    await vi.waitFor(() => expect(document.querySelector('.history-chart path[data-metric="bytes-in"]')).not.toBeNull());
    expect(document.querySelector('.history-chart path[data-metric="bytes-in"]')?.getAttribute('d')?.match(/M/gu))
      .toHaveLength(2);
    panel.unmount();
  });

  it('states that background monitoring continues when there are no incidents', async () => {
    const value = snapshot();
    value.incidents = [];
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getSnapshot') return value;
      if (method === 'getTrafficHistory') return historyResult();
      if (method === 'getHistoryStatus') return historyStatus();
      throw new Error(`Unexpected ${method}`);
    });
    const panel = (await import('../panel.guard/src/index')).default;
    await panel.mount({ message: { request } });
    document.querySelector<HTMLButtonElement>('[role="tab"][data-tab="incidents"]')!.click();

    expect(document.querySelector('.ledger-empty')?.textContent).toContain('后台监控仍在继续');
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
      metric: 'bytes-in', unit: 'bytes', agent: 'claude', provider: 'custom', hostname: 'relay.example.test',
      points: [{
        start: NOW - 120_000, end: NOW - 60_000, value: 1024, coverage: 'complete', coverageReason: null,
        provenance: 'network-sample', quality: 'measured',
      }, {
        start: NOW - 60_000, end: NOW, value: null, coverage: 'missing', coverageReason: 'collector-stopped',
        provenance: null, quality: null,
      }],
    }, {
      metric: 'bytes-in', unit: 'bytes', agent: 'codex', provider: 'custom', hostname: 'relay.example.test',
      points: [{
        start: NOW - 120_000, end: NOW - 60_000, value: 2048, coverage: 'complete', coverageReason: null,
        provenance: 'network-sample', quality: 'measured',
      }, {
        start: NOW - 60_000, end: NOW, value: null, coverage: 'missing', coverageReason: 'collector-stopped',
        provenance: null, quality: null,
      }],
    }, {
      metric: 'bytes-out', unit: 'bytes', agent: 'claude', provider: 'custom', hostname: 'relay.example.test',
      points: [{
        start: NOW - 120_000, end: NOW - 60_000, value: 1024, coverage: 'complete', coverageReason: null,
        provenance: 'network-sample', quality: 'measured',
      }, {
        start: NOW - 60_000, end: NOW, value: 0, coverage: 'complete', coverageReason: null,
        provenance: 'network-sample', quality: 'measured',
      }],
    }, {
      metric: 'bytes-out', unit: 'bytes', agent: 'codex', provider: 'custom', hostname: 'relay.example.test',
      points: [{
        start: NOW - 120_000, end: NOW - 60_000, value: 512, coverage: 'complete', coverageReason: null,
        provenance: 'network-sample', quality: 'measured',
      }, {
        start: NOW - 60_000, end: NOW, value: 0, coverage: 'complete', coverageReason: null,
        provenance: 'network-sample', quality: 'measured',
      }],
    }],
    summary: [{ metric: 'bytes-out', unit: 'bytes', value: 0, coverageRatio: 0.5, derivedRatio: 0 }],
    sources: [{ provenance: 'network-sample', quality: 'measured', pointCount: 1 }],
    warnings: ['partial-collector-coverage'],
  };
}

function modelHistoryResult() {
  return {
    ...historyResult(),
    domain: 'model-usage',
    series: [
      ...modelHistorySeries('input-tokens', 'tokens', 120, 80),
      ...modelHistorySeries('output-tokens', 'tokens', 60, 40),
      ...modelHistorySeries('cache-tokens', 'tokens', 30, 20),
      ...modelHistorySeries('requests', 'requests', 6, 4),
      ...modelHistorySeries('sessions', 'sessions', 2, 1),
    ],
    summary: [
      { metric: 'input-tokens', unit: 'tokens', value: 200, coverageRatio: 1, derivedRatio: 0 },
      { metric: 'output-tokens', unit: 'tokens', value: 100, coverageRatio: 1, derivedRatio: 0 },
      { metric: 'cache-tokens', unit: 'tokens', value: 50, coverageRatio: 1, derivedRatio: 0 },
      { metric: 'requests', unit: 'requests', value: 10, coverageRatio: 1, derivedRatio: 0 },
      { metric: 'sessions', unit: 'sessions', value: 3, coverageRatio: 1, derivedRatio: 0 },
    ],
    sources: [{ provenance: 'local-session', quality: 'derived', pointCount: 10 }],
  };
}

function agentSummaryHistoryResult() {
  return {
    ...historyResult(),
    series: [
      ...agentSummarySeries('bytes-in', 'claude', 'anthropic.example.test', [100]),
      ...agentSummarySeries('bytes-in', 'claude', 'relay.example.test', [200]),
      ...agentSummarySeries('bytes-in', 'codex', 'openai.example.test', [0]),
      ...agentSummarySeries('bytes-out', 'codex', 'openai.example.test', [500, null]),
    ],
    summary: [],
  };
}

function agentSummarySeries(
  metric: 'bytes-in' | 'bytes-out',
  agent: 'claude' | 'codex',
  hostname: string,
  values: Array<number | null>,
) {
  return [{
    metric, unit: 'bytes', agent, provider: 'custom', hostname,
    points: values.map((value, index) => ({
      start: NOW - (values.length - index) * 60_000,
      end: NOW - (values.length - index - 1) * 60_000,
      value,
      coverage: value === null ? 'missing' : 'complete',
      coverageReason: value === null ? 'collector-stopped' : null,
      provenance: value === null ? null : 'network-sample',
      quality: value === null ? null : 'measured',
    })),
  }];
}

function modelHistorySeries(metric: string, unit: string, claude: number, codex: number) {
  return [{
    metric, unit, agent: 'claude', provider: 'custom', hostname: 'relay.example.test',
    points: [{
      start: NOW - 60_000, end: NOW, value: claude, coverage: 'complete', coverageReason: null,
      provenance: 'local-session', quality: 'derived',
    }],
  }, {
    metric, unit, agent: 'codex', provider: 'custom', hostname: 'relay.example.test',
    points: [{
      start: NOW - 60_000, end: NOW, value: codex, coverage: 'complete', coverageReason: null,
      provenance: 'local-session', quality: 'derived',
    }],
  }];
}

function emptyHistoryResult(domain: 'network' | 'model-usage') {
  return {
    ...historyResult(),
    domain,
    series: [],
    summary: [],
    sources: [],
    warnings: [],
  };
}

function positionedHistoryResult() {
  const from = NOW - 240_000;
  return {
    ...historyResult(),
    from,
    series: [{
      metric: 'bytes-in', unit: 'bytes', agent: 'claude', provider: 'custom', hostname: 'relay.example.test',
      points: [{
        start: from, end: from + 120_000, value: 10, coverage: 'complete', coverageReason: null,
        provenance: 'network-sample', quality: 'measured',
      }, {
        start: from + 120_000, end: NOW, value: 20, coverage: 'complete', coverageReason: null,
        provenance: 'network-sample', quality: 'measured',
      }],
    }, {
      metric: 'bytes-out', unit: 'bytes', agent: 'claude', provider: 'custom', hostname: 'relay.example.test',
      points: [{
        start: from + 120_000, end: NOW, value: 5, coverage: 'complete', coverageReason: null,
        provenance: 'network-sample', quality: 'measured',
      }],
    }],
    summary: [
      { metric: 'bytes-in', unit: 'bytes', value: 30, coverageRatio: 1, derivedRatio: 0 },
      { metric: 'bytes-out', unit: 'bytes', value: 5, coverageRatio: 1, derivedRatio: 0 },
    ],
  };
}

function historyWithMissingBucketObject() {
  const from = NOW - 180_000;
  return {
    ...historyResult(),
    from,
    series: [{
      metric: 'bytes-in', unit: 'bytes', agent: 'claude', provider: 'custom', hostname: 'relay.example.test',
      points: [{
        start: from, end: from + 60_000, value: 10, coverage: 'complete', coverageReason: null,
        provenance: 'network-sample', quality: 'measured',
      }, {
        start: from + 120_000, end: NOW, value: 10, coverage: 'complete', coverageReason: null,
        provenance: 'network-sample', quality: 'measured',
      }],
    }],
    summary: [{ metric: 'bytes-in', unit: 'bytes', value: 20, coverageRatio: 2 / 3, derivedRatio: 0 }],
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
