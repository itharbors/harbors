import { describe, expect, it, vi } from 'vitest';

import { createIncidentNotifier } from '../main/src/notifications.js';

describe('incident notifications', () => {
  it('deduplicates Agent endpoint rule notices for ten minutes', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    let now = 1_000;
    const notifier = createIncidentNotifier({ port: 19001, fetch, now: () => now });
    const notice = {
      agent: 'claude' as const, endpoint: 'relay.example.test', ruleId: 'dynamic-warning',
      level: 'warning' as const, summary: 'Traffic exceeded the learned baseline',
    };
    await notifier.notify(notice);
    await notifier.notify(notice);
    now += 10 * 60_000 + 1;
    await notifier.notify(notice);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][0]).toBe('http://127.0.0.1:19001/v1/notifications');
  });
});
