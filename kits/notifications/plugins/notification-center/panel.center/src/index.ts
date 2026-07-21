type PanelContext = {
  message: {
    request(plugin: string, name: string, ...args: unknown[]): Promise<unknown>;
  };
};

type NotificationLevel = 'info' | 'success' | 'warning' | 'error';

type NotificationItem = {
  id: string;
  title: string;
  body: string;
  level: NotificationLevel;
  source: string | null;
  durationMs: number | null;
  persistent: boolean;
  createdAt: string;
  read: boolean;
};

type NotificationSnapshot = {
  notifications: NotificationItem[];
  unreadCount: number;
};

type PanelDefinition = {
  mount(ctx: PanelContext): Promise<void>;
  unmount(): void;
};

const PLUGIN_NAME = '@itharbors/notification-center';
const POLL_INTERVAL_MS = 1000;
const LEVEL_LABELS: Record<NotificationLevel, string> = {
  info: 'Info',
  success: 'Success',
  warning: 'Warning',
  error: 'Error',
};

let context: PanelContext | null = null;
let rootElement: HTMLElement | null = null;
let pollTimer: number | null = null;
let requestInFlight = false;
let mounted = false;

const definition: PanelDefinition = {
  async mount(ctx) {
    context = ctx;
    rootElement = document.getElementById('panel-root');
    if (!rootElement) {
      throw new Error('Panel root element #panel-root not found');
    }
    mounted = true;
    renderLoading();
    await refresh();
    if (mounted) {
      pollTimer = window.setInterval(() => {
        void refresh();
      }, POLL_INTERVAL_MS);
    }
  },
  unmount() {
    mounted = false;
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
    requestInFlight = false;
    context = null;
    rootElement = null;
  },
};

export default definition;

async function refresh() {
  if (!mounted || !context || requestInFlight) return;
  requestInFlight = true;
  try {
    const value = await context.message.request(PLUGIN_NAME, 'getSnapshot');
    if (mounted) renderSnapshot(normalizeSnapshot(value));
  } catch (error) {
    if (mounted) renderUnavailable(error);
  } finally {
    requestInFlight = false;
  }
}

async function runAction(method: string, ...args: unknown[]) {
  if (!mounted || !context) return;
  try {
    await context.message.request(PLUGIN_NAME, method, ...args);
    await refresh();
  } catch (error) {
    if (mounted) renderUnavailable(error);
  }
}

function renderLoading() {
  if (!rootElement) return;
  const state = createState('Connecting to the notification service…', 'loading');
  rootElement.replaceChildren(state);
}

function renderSnapshot(snapshot: NotificationSnapshot) {
  if (!rootElement) return;
  const workspace = document.createElement('main');
  workspace.className = 'notification-workspace';
  workspace.append(createHeader(snapshot.unreadCount));

  const content = document.createElement('section');
  content.className = 'notification-feed';
  content.setAttribute('aria-label', 'Notification history');
  if (snapshot.notifications.length === 0) {
    content.append(createEmptyState());
  } else {
    for (const notification of snapshot.notifications) {
      content.append(createNotificationCard(notification));
    }
  }

  const status = document.createElement('div');
  status.className = 'sr-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = `${snapshot.unreadCount} unread notifications`;

  workspace.append(content, status);
  rootElement.replaceChildren(workspace);
}

function createHeader(unreadCount: number) {
  const header = document.createElement('header');
  header.className = 'workspace-header';

  const identity = document.createElement('div');
  identity.className = 'workspace-identity';
  const eyebrow = document.createElement('span');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = 'Agent signal desk';
  const title = document.createElement('h1');
  title.textContent = 'Notifications';
  const description = document.createElement('p');
  description.textContent = 'Important results and requests from your agents.';
  identity.append(eyebrow, title, description);

  const controls = document.createElement('div');
  controls.className = 'workspace-controls';
  const count = document.createElement('span');
  count.className = 'unread-count';
  count.dataset.unreadCount = '';
  count.textContent = `${unreadCount} unread`;
  const markAll = createButton('Mark all read', 'mark-all-read', () => {
    void runAction('markAllRead');
  });
  markAll.disabled = unreadCount === 0;
  controls.append(count, markAll);

  header.append(identity, controls);
  return header;
}

function createNotificationCard(notification: NotificationItem) {
  const card = document.createElement('article');
  card.className = `notification-card level-${notification.level}`;
  if (!notification.read) card.classList.add('is-unread');
  card.dataset.notificationId = notification.id;

  const signalRail = document.createElement('span');
  signalRail.className = 'signal-rail';
  signalRail.setAttribute('aria-hidden', 'true');

  const content = document.createElement('div');
  content.className = 'notification-content';

  const meta = document.createElement('div');
  meta.className = 'notification-meta';
  const level = document.createElement('span');
  level.className = 'level-label';
  level.textContent = LEVEL_LABELS[notification.level];
  const source = document.createElement('span');
  source.textContent = notification.source ?? 'Unknown source';
  const time = document.createElement('time');
  time.dateTime = notification.createdAt;
  time.textContent = formatTimestamp(notification.createdAt);
  meta.append(level, source, time);
  if (notification.persistent) {
    const persistent = document.createElement('span');
    persistent.className = 'persistent-label';
    persistent.textContent = 'Persistent';
    meta.append(persistent);
  }

  const heading = document.createElement('h2');
  heading.textContent = notification.title;
  content.append(meta, heading);
  if (notification.body) {
    const body = document.createElement('p');
    body.className = 'notification-body';
    body.textContent = notification.body;
    content.append(body);
  }

  const actions = document.createElement('div');
  actions.className = 'notification-actions';
  if (!notification.read) {
    actions.append(createButton('Mark read', 'mark-read', () => {
      void runAction('markRead', notification.id);
    }));
  }
  actions.append(createButton('Delete', 'remove', () => {
    void runAction('removeNotification', notification.id);
  }, 'button-quiet'));

  card.append(signalRail, content, actions);
  return card;
}

function createEmptyState() {
  const state = createState('No notifications yet', 'empty');
  const detail = document.createElement('p');
  detail.textContent = 'Agent notifications will appear here when important work changes state.';
  state.append(detail);
  return state;
}

function renderUnavailable(error: unknown) {
  if (!rootElement) return;
  const message = error instanceof Error ? error.message : String(error);
  const state = createState('Desktop notification service is unavailable', 'unavailable');
  const detail = document.createElement('p');
  detail.textContent = message.includes('unavailable')
    ? 'Start ITHARBORS in Electron desktop mode, then try again.'
    : message;
  const retry = createButton('Try again', 'retry', () => {
    void refresh();
  });
  state.append(detail, retry);
  rootElement.replaceChildren(state);
}

function createState(title: string, stateName: string) {
  const state = document.createElement('section');
  state.className = `panel-state state-${stateName}`;
  state.dataset.state = stateName;
  const heading = document.createElement('h2');
  heading.textContent = title;
  state.append(heading);
  return state;
}

function createButton(
  label: string,
  action: string,
  handler: () => void,
  className = '',
) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.dataset.action = action;
  if (className) button.className = className;
  button.addEventListener('click', handler);
  return button;
}

function normalizeSnapshot(value: unknown): NotificationSnapshot {
  if (!value || typeof value !== 'object') {
    throw new Error('Notification Host returned an invalid snapshot');
  }
  const candidate = value as Partial<NotificationSnapshot>;
  if (!Array.isArray(candidate.notifications) || !Number.isInteger(candidate.unreadCount)) {
    throw new Error('Notification Host returned an invalid snapshot');
  }
  return {
    notifications: candidate.notifications as NotificationItem[],
    unreadCount: candidate.unreadCount as number,
  };
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown time';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
