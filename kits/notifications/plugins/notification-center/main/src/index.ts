declare const editor: any;

const DEFAULT_NOTIFICATION_PORT = 17896;
const CENTER_PANEL = '@itharbors/notification-center.center';

let runtime: any;

editor.plugin.define({
  lifecycle: {
    load(ctx: any) {
      runtime = ctx;
    },
  },
  methods: {
    getSnapshot() {
      return hostRequest('/v1/notifications');
    },
    markRead(id: unknown) {
      return hostRequest(`/v1/notifications/${encodeId(id)}/read`, { method: 'POST' });
    },
    markAllRead() {
      return hostRequest('/v1/notifications/read-all', { method: 'POST' });
    },
    removeNotification(id: unknown) {
      return hostRequest(`/v1/notifications/${encodeId(id)}`, { method: 'DELETE' });
    },
    openCenterPanel() {
      return runtime.window.openPanel(CENTER_PANEL);
    },
  },
});

async function hostRequest(pathname: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${hostBaseUrl()}${pathname}`, init);
  } catch {
    throw new Error('Desktop notification service is unavailable');
  }

  if (response.status === 204) return undefined;

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    const message = getErrorMessage(payload)
      ?? `Notification Host returned HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

function hostBaseUrl(): string {
  const rawPort = process.env.HARBORS_NOTIFICATION_PORT;
  const port = rawPort === undefined || rawPort === ''
    ? DEFAULT_NOTIFICATION_PORT
    : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('HARBORS_NOTIFICATION_PORT must be an integer between 1 and 65535');
  }
  return `http://127.0.0.1:${port}`;
}

function encodeId(id: unknown): string {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error('Notification id is required');
  }
  return encodeURIComponent(id);
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Notification Host returned invalid JSON');
  }
}

function getErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.length > 0 ? message : undefined;
}
