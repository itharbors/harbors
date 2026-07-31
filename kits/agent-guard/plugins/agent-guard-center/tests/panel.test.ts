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
