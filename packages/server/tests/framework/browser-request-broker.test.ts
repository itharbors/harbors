import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserRequestBroker } from '../../src/framework/browser-request-broker';

describe('BrowserRequestBroker', () => {
  let broker: BrowserRequestBroker;

  beforeEach(() => {
    vi.useFakeTimers();
    broker = new BrowserRequestBroker();
  });

  afterEach(() => {
    broker.destroy();
    vi.useRealTimers();
  });

  it('resolves only from the owning session and rejects duplicate results', async () => {
    const dispatch = vi.fn();
    const pending = broker.request('session-a', dispatch, {
      panel: '@itharbors/log.log', method: 'getLogs', args: [],
    });
    const requestId = dispatch.mock.calls[0][0].requestId as string;

    expect(broker.resolve('session-b', requestId, { ok: true, value: [] })).toBe('wrong-session');
    expect(broker.resolve('session-a', requestId, { ok: true, value: ['ok'] })).toBe('resolved');
    await expect(pending).resolves.toEqual(['ok']);
    expect(broker.resolve('session-a', requestId, { ok: true, value: [] })).toBe('missing');
    expect(broker.pendingCount()).toBe(0);
  });

  it('rejects browser errors and removes the pending request', async () => {
    const dispatch = vi.fn();
    const pending = broker.request('session-a', dispatch, {
      panel: 'panel', method: 'run', args: [],
    });
    const requestId = dispatch.mock.calls[0][0].requestId as string;

    expect(broker.resolve('session-a', requestId, { ok: false, error: 'failed' })).toBe('resolved');
    await expect(pending).rejects.toThrow('failed');
    expect(broker.pendingCount()).toBe(0);
  });

  it('times out after ten seconds', async () => {
    const pending = broker.request('session-a', vi.fn(), {
      panel: 'panel', method: 'run', args: [],
    });
    const rejected = expect(pending).rejects.toThrow(/timed out after 10000ms/);

    await vi.advanceTimersByTimeAsync(10_000);

    await rejected;
    expect(broker.pendingCount()).toBe(0);
  });

  it('rejects every pending request owned by a disconnected session', async () => {
    const first = broker.request('session-a', vi.fn(), { panel: 'p', method: 'a', args: [] });
    const second = broker.request('session-b', vi.fn(), { panel: 'p', method: 'b', args: [] });

    broker.rejectSession('session-a', new Error('Browser disconnected'));

    await expect(first).rejects.toThrow('Browser disconnected');
    expect(broker.pendingCount()).toBe(1);
    broker.rejectSession('session-b', new Error('done'));
    await expect(second).rejects.toThrow('done');
  });

  it('rejects all pending requests when destroyed', async () => {
    const pending = broker.request('session-a', vi.fn(), { panel: 'p', method: 'a', args: [] });

    broker.destroy();

    await expect(pending).rejects.toThrow('BrowserRequestBroker destroyed');
    expect(broker.pendingCount()).toBe(0);
  });
});
