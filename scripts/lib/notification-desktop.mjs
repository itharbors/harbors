const DEFAULT_TOAST_DURATION_MS = 8000;
const DEFAULT_TOAST_WIDTH = 360;
const DEFAULT_TOAST_MARGIN = 16;
const DEFAULT_TOAST_GAP = 12;

export function createToastQueue({
  limit = 3,
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancelSchedule = (token) => clearTimeout(token),
  onShow = (_notification, markShown) => markShown(),
  onHide = () => {},
  onError = (error) => console.error('Notification toast adapter failed:', error),
} = {}) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError('Toast queue limit must be a positive integer');
  }

  const visible = new Map();
  const pending = [];
  const knownIds = new Set();
  let disposed = false;

  function enqueue(notification) {
    if (disposed) return false;
    if (!notification || typeof notification.id !== 'string' || notification.id.length === 0) {
      throw new TypeError('Toast notification id is required');
    }
    if (knownIds.has(notification.id)) return false;

    knownIds.add(notification.id);
    if (visible.size < limit) {
      activate(notification);
    } else {
      pending.push(notification);
    }
    return true;
  }

  function activate(notification) {
    const active = { notification, timer: null, shown: false };
    visible.set(notification.id, active);
    safelyCall(onShow, [notification, () => markShown(notification.id, active)], onError);
  }

  function markShown(id, expected) {
    const active = visible.get(id);
    if (disposed || active !== expected || active.shown) return false;
    active.shown = true;
    if (!active.notification.persistent) {
      const duration = Number.isInteger(active.notification.durationMs)
        ? active.notification.durationMs
        : DEFAULT_TOAST_DURATION_MS;
      active.timer = schedule(() => {
        close(id, 'expired');
      }, duration);
    }
    return true;
  }

  function close(id, reason = 'closed') {
    const active = visible.get(id);
    if (active) {
      visible.delete(id);
      knownIds.delete(id);
      if (active.timer !== null) cancelSchedule(active.timer);
      safelyCall(onHide, [active.notification, reason], onError);
      promotePending();
      return true;
    }

    const pendingIndex = pending.findIndex((notification) => notification.id === id);
    if (pendingIndex >= 0) {
      pending.splice(pendingIndex, 1);
      knownIds.delete(id);
      return true;
    }
    return false;
  }

  function remove(id) {
    return close(id, 'removed');
  }

  function promotePending() {
    while (!disposed && visible.size < limit && pending.length > 0) {
      activate(pending.shift());
    }
  }

  function snapshot() {
    return {
      visible: Array.from(visible.keys()),
      pending: pending.map((notification) => notification.id),
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    pending.length = 0;
    for (const { notification, timer } of visible.values()) {
      if (timer !== null) cancelSchedule(timer);
      safelyCall(onHide, [notification, 'disposed'], onError);
    }
    visible.clear();
    knownIds.clear();
  }

  return { enqueue, close, remove, snapshot, dispose };
}

export function createNotificationHtml(notification) {
  const level = ['info', 'success', 'warning', 'error'].includes(notification.level)
    ? notification.level
    : 'info';
  const title = escapeHtml(notification.title ?? 'Notification');
  const body = escapeHtml(notification.body ?? '');
  const source = escapeHtml(notification.source ?? 'Unknown source');
  const persistent = notification.persistent
    ? '<span class="persistent">Persistent</span>'
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root { color-scheme: dark; --accent: #76d0ec; --ink: #07111d; --surface: #102235; --line: #36536b; --text: #eaf7ff; --muted: #9ab0bf; }
    :root[data-level="success"] { --accent: #69d6a2; }
    :root[data-level="warning"] { --accent: #f0ba57; }
    :root[data-level="error"] { --accent: #ff7070; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 8px; overflow: hidden; background: transparent; font-family: "Avenir Next", "Segoe UI", sans-serif; }
    .toast { position: relative; display: grid; grid-template-columns: 4px minmax(0,1fr) auto; gap: 14px; min-height: 152px; border: 1px solid var(--line); background: var(--surface); color: var(--text); box-shadow: 0 18px 42px rgba(0,0,0,.42); clip-path: polygon(0 0, calc(100% - 12px) 0, 100% 12px, 100% 100%, 0 100%); }
    .rail { background: var(--accent); box-shadow: 0 0 12px color-mix(in srgb, var(--accent), transparent 60%); }
    .open { min-width: 0; border: 0; padding: 17px 0 16px; background: transparent; color: inherit; text-align: left; cursor: pointer; }
    .meta { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; color: var(--accent); font: 9px/1.2 "SFMono-Regular", Consolas, monospace; letter-spacing: .1em; text-transform: uppercase; }
    .persistent { border-left: 1px solid var(--line); padding-left: 8px; color: var(--text); }
    h1 { margin: 0; font: 500 20px/1.15 "Iowan Old Style", Georgia, serif; letter-spacing: -.01em; }
    p { display: -webkit-box; margin: 8px 0 0; overflow: hidden; color: #c6d5df; font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
    .close { align-self: start; margin: 10px 9px 0 0; border: 0; width: 28px; height: 28px; background: transparent; color: var(--muted); font: 20px/1 sans-serif; cursor: pointer; }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  </style>
</head>
<body>
  <article class="toast">
    <span class="rail" aria-hidden="true"></span>
    <button class="open" type="button" data-action="open">
      <span class="meta">${escapeHtml(capitalize(level))}<span>${source}</span>${persistent}</span>
      <h1>${title}</h1>
      ${body ? `<p>${body}</p>` : ''}
    </button>
    <button class="close" type="button" data-action="close" aria-label="Close notification">×</button>
  </article>
  <script>
    document.documentElement.dataset.level = ${JSON.stringify(level)};
    document.querySelector('[data-action="open"]').addEventListener('click', () => window.notificationToast.openCenter());
    document.querySelector('[data-action="close"]').addEventListener('click', () => window.notificationToast.closeToast());
  </script>
</body>
</html>`;
}

export function formatNotificationCount(count) {
  const normalized = normalizeCount(count);
  return normalized > 99 ? '99+' : String(normalized);
}

export function createBadgeOverlayDataUrl(count) {
  const normalized = normalizeCount(count);
  if (normalized === 0) return null;
  const label = formatNotificationCount(normalized);
  const fontSize = label.length > 2 ? 24 : 30;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><circle cx="32" cy="32" r="29" fill="#d83b3b" stroke="#ffffff" stroke-width="4"/><text x="32" y="41" fill="#ffffff" font-family="Arial,sans-serif" font-size="${fontSize}" font-weight="700" text-anchor="middle">${label}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function formatNotificationKitLabel(label, count) {
  const normalized = normalizeCount(count);
  return normalized === 0 ? label : `${label} (${normalized})`;
}

export function formatNotificationTooltip(count) {
  const normalized = normalizeCount(count);
  if (normalized === 0) return 'ITHARBORS — No unread notifications';
  if (normalized === 1) return 'ITHARBORS — 1 unread notification';
  return `ITHARBORS — ${normalized} unread notifications`;
}

export function calculateToastPositions(workArea, heights, {
  width = DEFAULT_TOAST_WIDTH,
  margin = DEFAULT_TOAST_MARGIN,
  gap = DEFAULT_TOAST_GAP,
} = {}) {
  const x = Math.round(workArea.x + workArea.width - margin - width);
  let bottom = workArea.y + workArea.height - margin;
  return heights.map((height) => {
    const y = Math.round(bottom - height);
    bottom = y - gap;
    return { x, y };
  });
}

function normalizeCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.floor(count);
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safelyCall(callback, args, onError) {
  try {
    callback(...args);
  } catch (error) {
    onError(error);
  }
}
