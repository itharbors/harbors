import { describe, expect, it, vi } from 'vitest';

import { createIncidentNotifier } from '../main/src/notifications.js';

describe('incident notifications', () => {
  it('deduplicates Agent endpoint rule notices for ten minutes', async () => {
    const create = vi.fn(async () => undefined);
    let now = 1_000;
    const notifier = createIncidentNotifier({ create, now: () => now });
    const notice = {
      agent: 'claude' as const, endpoint: 'relay.example.test', ruleId: 'dynamic-warning',
      level: 'warning' as const, summary: 'Traffic exceeded the learned baseline',
    };
    await notifier.notify(notice);
    await notifier.notify(notice);
    now += 10 * 60_000 + 1;
    await notifier.notify(notice);

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0]).toMatchObject({ source: 'Agent Guard', level: 'warning' });
  });
});
