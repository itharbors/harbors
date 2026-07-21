// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Notification = {
  id: string;
  title: string;
  body: string;
  level: 'info' | 'success' | 'warning' | 'error';
  source: string | null;
  durationMs: number | null;
  persistent: boolean;
  createdAt: string;
  read: boolean;
};

type Snapshot = {
  notifications: Notification[];
  unreadCount: number;
};

type PanelDefinition = {
  mount(context: unknown): Promise<void>;
  unmount(): void;
};

const first: Notification = {
  id: 'n-1',
  title: 'Build completed',
  body: 'All checks passed.',
  level: 'success',
  source: 'Codex',
  durationMs: 8000,
  persistent: false,
  createdAt: '2026-07-21T10:00:00.000Z',
  read: true,
};

const second: Notification = {
  id: 'n-2',
  title: 'Approval required',
  body: 'Review the production release.',
  level: 'warning',
  source: 'Release Agent',
  durationMs: null,
  persistent: true,
  createdAt: '2026-07-21T10:01:00.000Z',
  read: false,
};

describe('Notification Center panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="panel-root"></div>';
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders notification details in Host order and performs row actions', async () => {
    let snapshot: Snapshot = { notifications: [second, first], unreadCount: 1 };
    const request = vi.fn(async (_plugin: string, method: string, id?: string) => {
      if (method === 'getSnapshot') return snapshot;
      if (method === 'markRead') {
        expect(id).toBe('n-2');
        snapshot = {
          notifications: [{ ...second, read: true }, first],
          unreadCount: 0,
        };
        return snapshot.notifications[0];
      }
      if (method === 'removeNotification') {
        expect(id).toBe('n-1');
        snapshot = { notifications: [{ ...second, read: true }], unreadCount: 0 };
        return undefined;
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const definition = await loadPanel();
    await definition.mount({ message: { request } });

    expect(document.querySelector('h1')?.textContent).toBe('Notifications');
    expect(document.querySelector('[data-unread-count]')?.textContent).toBe('1 unread');
    const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-notification-id]'));
    expect(cards.map((card) => card.dataset.notificationId)).toEqual(['n-2', 'n-1']);
    expect(cards[0].classList.contains('is-unread')).toBe(true);
    expect(cards[0].classList.contains('level-warning')).toBe(true);
    expect(cards[0].textContent).toContain('Approval required');
    expect(cards[0].textContent).toContain('Review the production release.');
    expect(cards[0].textContent).toContain('Release Agent');
    expect(cards[0].querySelector('time')?.getAttribute('datetime')).toBe(second.createdAt);

    cards[0].querySelector<HTMLButtonElement>('[data-action="mark-read"]')!.click();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith('@itharbors/notification-center', 'markRead', 'n-2');
      expect(document.querySelector('[data-unread-count]')?.textContent).toBe('0 unread');
    });

    document.querySelector<HTMLElement>('[data-notification-id="n-1"]')!
      .querySelector<HTMLButtonElement>('[data-action="remove"]')!
      .click();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith('@itharbors/notification-center', 'removeNotification', 'n-1');
      expect(document.querySelectorAll('[data-notification-id]')).toHaveLength(1);
    });
    definition.unmount();
  });

  it('marks every notification read and renders the empty state', async () => {
    let snapshot: Snapshot = { notifications: [second], unreadCount: 1 };
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getSnapshot') return snapshot;
      if (method === 'markAllRead') {
        snapshot = { notifications: [{ ...second, read: true }], unreadCount: 0 };
        return { unreadCount: 0 };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const definition = await loadPanel();
    await definition.mount({ message: { request } });

    document.querySelector<HTMLButtonElement>('[data-action="mark-all-read"]')!.click();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith('@itharbors/notification-center', 'markAllRead');
      expect(document.querySelector('[data-unread-count]')?.textContent).toBe('0 unread');
      expect(document.querySelector('[data-notification-id]')?.classList.contains('is-unread')).toBe(false);
    });
    definition.unmount();

    document.body.innerHTML = '<div id="panel-root"></div>';
    const emptyDefinition = await loadPanel();
    await emptyDefinition.mount({
      message: { request: vi.fn(async () => ({ notifications: [], unreadCount: 0 })) },
    });
    expect(document.querySelector('[data-state="empty"]')?.textContent).toContain('No notifications yet');
    emptyDefinition.unmount();
  });

  it('renders an unavailable state and retries successfully', async () => {
    let unavailable = true;
    const request = vi.fn(async () => {
      if (unavailable) throw new Error('Desktop notification service is unavailable');
      return { notifications: [first], unreadCount: 0 };
    });
    const definition = await loadPanel();
    await definition.mount({ message: { request } });

    const error = document.querySelector('[data-state="unavailable"]');
    expect(error?.textContent).toContain('Desktop notification service is unavailable');
    unavailable = false;
    error?.querySelector<HTMLButtonElement>('[data-action="retry"]')!.click();

    await vi.waitFor(() => {
      expect(document.querySelector('[data-notification-id="n-1"]')).not.toBeNull();
    });
    definition.unmount();
  });

  it('polls once per second without overlapping and stops on unmount', async () => {
    vi.useFakeTimers();
    let resolveRequest: (() => void) | undefined;
    const request = vi.fn(async () => {
      await new Promise<void>((resolve) => { resolveRequest = resolve; });
      return { notifications: [], unreadCount: 0 };
    });
    const definition = await loadPanel();
    const mounting = definition.mount({ message: { request } });
    resolveRequest!();
    await mounting;
    expect(request).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(request).toHaveBeenCalledTimes(2);
    resolveRequest!();
    await Promise.resolve();

    definition.unmount();
    await vi.advanceTimersByTimeAsync(2000);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('preserves focused DOM when a poll returns an unchanged snapshot', async () => {
    vi.useFakeTimers();
    const snapshot: Snapshot = { notifications: [second], unreadCount: 1 };
    const request = vi.fn(async () => snapshot);
    const definition = await loadPanel();
    await definition.mount({ message: { request } });

    const originalCard = document.querySelector<HTMLElement>('[data-notification-id="n-2"]')!;
    const originalButton = originalCard.querySelector<HTMLButtonElement>('[data-action="mark-read"]')!;
    originalButton.focus();
    await vi.advanceTimersByTimeAsync(1000);

    expect(request).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-notification-id="n-2"]')).toBe(originalCard);
    expect(document.activeElement).toBe(originalButton);
    definition.unmount();
  });

  it('serializes duplicate mutation clicks', async () => {
    let snapshot: Snapshot = { notifications: [first], unreadCount: 0 };
    let resolveDelete: (() => void) | undefined;
    const deleteResult = new Promise<void>((resolve) => { resolveDelete = resolve; });
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getSnapshot') return snapshot;
      if (method === 'removeNotification') {
        await deleteResult;
        snapshot = { notifications: [], unreadCount: 0 };
        return undefined;
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const definition = await loadPanel();
    await definition.mount({ message: { request } });

    const deleteButton = document.querySelector<HTMLButtonElement>('[data-action="remove"]')!;
    deleteButton.click();
    deleteButton.click();
    expect(request.mock.calls.filter((call) => call[1] === 'removeNotification')).toHaveLength(1);
    expect(deleteButton.disabled).toBe(true);

    resolveDelete!();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-state="empty"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-state="unavailable"]')).toBeNull();
    definition.unmount();
  });

  it('discards a stale poll after a newer mutation', async () => {
    vi.useFakeTimers();
    let snapshot: Snapshot = { notifications: [first], unreadCount: 0 };
    let resolveStalePoll: ((value: Snapshot) => void) | undefined;
    let snapshotCalls = 0;
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getSnapshot') {
        snapshotCalls += 1;
        if (snapshotCalls === 2) {
          return new Promise<Snapshot>((resolve) => { resolveStalePoll = resolve; });
        }
        return snapshot;
      }
      if (method === 'removeNotification') {
        snapshot = { notifications: [], unreadCount: 0 };
        return undefined;
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const definition = await loadPanel();
    await definition.mount({ message: { request } });

    await vi.advanceTimersByTimeAsync(1000);
    document.querySelector<HTMLButtonElement>('[data-action="remove"]')!.click();
    await Promise.resolve();
    resolveStalePoll!({ notifications: [first], unreadCount: 0 });
    await vi.waitFor(() => {
      expect(document.querySelector('[data-state="empty"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-notification-id="n-1"]')).toBeNull();
    definition.unmount();
  });

  it('does not report a stale poll failure after a successful mutation', async () => {
    vi.useFakeTimers();
    let snapshot: Snapshot = { notifications: [first], unreadCount: 0 };
    let rejectStalePoll: ((error: Error) => void) | undefined;
    let snapshotCalls = 0;
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getSnapshot') {
        snapshotCalls += 1;
        if (snapshotCalls === 2) {
          return new Promise<Snapshot>((_resolve, reject) => { rejectStalePoll = reject; });
        }
        return snapshot;
      }
      if (method === 'removeNotification') {
        snapshot = { notifications: [], unreadCount: 0 };
        return undefined;
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const definition = await loadPanel();
    await definition.mount({ message: { request } });

    await vi.advanceTimersByTimeAsync(1000);
    document.querySelector<HTMLButtonElement>('[data-action="remove"]')!.click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-state="empty"]')).not.toBeNull();
    });
    rejectStalePoll!(new Error('Obsolete poll failed'));
    await Promise.resolve();
    expect(document.querySelector('[data-state="unavailable"]')).toBeNull();
    definition.unmount();
  });
});

async function loadPanel() {
  return (await import('../panel.center/src/index')).default as PanelDefinition;
}
