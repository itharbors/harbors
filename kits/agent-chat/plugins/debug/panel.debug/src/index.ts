import {
  appendMessage,
  createBroadcastMessage,
  createRequestMessage,
  type MessageMeta,
  type RuntimeMessage,
  stringifyPayload,
} from './state.js';
import { getVirtualWindow, shouldFollowLatest, type RowHeightMap } from './virtualization.js';

type PanelDefinition = {
  mount?(): void | Promise<void>;
  methods?: Record<string, (...args: unknown[]) => unknown>;
};

const count = document.getElementById('message-count');
const updated = document.getElementById('message-updated');
const messagesContainer = document.getElementById('messages');
const clearBtn = document.getElementById('clear-btn');

const definition: PanelDefinition = {
  mount() {
    clearBtn?.addEventListener('click', clearLocalMessages);
    messagesContainer?.addEventListener('scroll', () => renderVisibleRows(), { passive: true });
    window.addEventListener('resize', () => renderVisibleRows());
    renderMessages();
  },
  methods: {
    onRequest(meta: unknown, ...args: unknown[]) {
      receiveMessage(createRequestMessage(asMeta(meta), args));
      return undefined;
    },
    onBroadcast(meta: unknown, ...args: unknown[]) {
      receiveMessage(createBroadcastMessage(asMeta(meta), args));
      return undefined;
    },
  },
};

export default definition;

const BOTTOM_THRESHOLD = 12;
let messages: RuntimeMessage[] = [];
let expandedMessageKeys = new Set<string>();
const rowHeights: RowHeightMap = new Map();

function asMeta(value: unknown): MessageMeta {
  return value && typeof value === 'object' ? value as MessageMeta : {};
}

function receiveMessage(message: RuntimeMessage): void {
  const container = requireElement(messagesContainer, 'messages');
  const followLatest = shouldFollowLatest(
    container.scrollTop,
    container.clientHeight,
    container.scrollHeight,
    BOTTOM_THRESHOLD,
  );
  messages = appendMessage(messages, message);
  pruneExpandedKeys();
  renderMessages();
  if (followLatest) scrollToLatest(container);
}

function clearLocalMessages(): void {
  messages = [];
  expandedMessageKeys = new Set<string>();
  rowHeights.clear();
  renderMessages();
  scrollToLatest(requireElement(messagesContainer, 'messages'));
}

function renderMessages(): void {
  const countElement = requireElement(count, 'message-count');
  const updatedElement = requireElement(updated, 'message-updated');
  const container = requireElement(messagesContainer, 'messages');

  countElement.textContent = `${messages.length} ${messages.length === 1 ? 'message' : 'messages'}`;
  updatedElement.textContent = messages.length > 0
    ? new Date(messages[messages.length - 1].timestamp).toLocaleTimeString()
    : 'not loaded';

  if (messages.length === 0) {
    container.replaceChildren(createEmptyState());
    return;
  }
  renderVisibleRows();
}

function renderVisibleRows(allowRemeasure = true): void {
  const container = requireElement(messagesContainer, 'messages');
  if (messages.length === 0) return;

  const viewportHeight = container.clientHeight || 600;
  const virtualWindow = getVirtualWindow(messages, container.scrollTop, viewportHeight, rowHeights);
  const fragment = document.createDocumentFragment();
  const topSpacer = document.createElement('div');
  topSpacer.className = 'virtual-spacer';
  topSpacer.style.height = `${virtualWindow.top}px`;
  fragment.append(topSpacer);

  for (let index = virtualWindow.start; index < virtualWindow.end; index += 1) {
    fragment.append(createMessageRow(messages[index]));
  }

  const bottomSpacer = document.createElement('div');
  bottomSpacer.className = 'virtual-spacer';
  bottomSpacer.style.height = `${virtualWindow.bottom}px`;
  fragment.append(bottomSpacer);
  container.replaceChildren(fragment);

  if (allowRemeasure && measureRenderedRows(container)) {
    renderVisibleRows(false);
  }
}

function createMessageRow(message: RuntimeMessage): HTMLElement {
  const key = message.id;
  const row = document.createElement('div');
  row.className = 'message';
  row.dataset.messageId = key;

  const rowHeader = document.createElement('div');
  rowHeader.className = 'message-row';

  const toggle = document.createElement('button');
  toggle.className = 'toggle';
  toggle.type = 'button';
  toggle.setAttribute('aria-label', 'Toggle message detail');

  const toggleIcon = document.createElement('span');
  toggleIcon.className = 'toggle-icon';
  toggleIcon.textContent = '▶';
  toggle.append(toggleIcon);

  const summary = document.createElement('div');
  summary.className = 'message-summary';
  const messageParts = getMessageParts(message.type);

  const type = document.createElement('div');
  type.className = 'message-type';
  type.textContent = messageParts.kind;

  const name = document.createElement('div');
  name.className = 'message-name';
  name.title = messageParts.name;
  name.textContent = messageParts.name;

  const time = document.createElement('div');
  time.className = 'message-time';
  time.textContent = new Date(message.timestamp).toLocaleTimeString();

  const detail = document.createElement('div');
  detail.className = 'message-detail';

  const payload = document.createElement('pre');
  payload.className = 'payload';
  payload.textContent = stringifyPayload(message.payload, true);

  const setExpanded = (expanded: boolean): void => {
    row.classList.toggle('expanded', expanded);
    toggle.setAttribute('aria-expanded', String(expanded));
    if (expanded) expandedMessageKeys.add(key);
    else expandedMessageKeys.delete(key);
  };

  toggle.addEventListener('click', () => {
    const nextExpanded = !row.classList.contains('expanded');
    setExpanded(nextExpanded);
    rowHeights.delete(message.id);
    renderVisibleRows();
  });

  detail.append(payload);
  summary.append(type, name, time);
  rowHeader.append(toggle, summary);
  row.append(rowHeader, detail);
  setExpanded(expandedMessageKeys.has(key));
  return row;
}

function createEmptyState(): HTMLElement {
  const empty = document.createElement('div');
  empty.className = 'empty';
  empty.textContent = 'No runtime messages captured yet.';
  return empty;
}

function measureRenderedRows(container: HTMLElement): boolean {
  let changed = false;
  container.querySelectorAll<HTMLElement>('.message[data-message-id]').forEach((row) => {
    const id = row.dataset.messageId;
    const height = row.getBoundingClientRect().height;
    if (!id || height <= 0 || rowHeights.get(id) === height) return;
    rowHeights.set(id, height);
    changed = true;
  });
  return changed;
}

function pruneExpandedKeys(): void {
  const activeIds = new Set(messages.map((message) => message.id));
  for (const id of expandedMessageKeys) {
    if (!activeIds.has(id)) expandedMessageKeys.delete(id);
  }
  for (const id of rowHeights.keys()) {
    if (!activeIds.has(id)) rowHeights.delete(id);
  }
}

function scrollToLatest(container: HTMLElement): void {
  container.scrollTop = container.scrollHeight;
}

function requireElement<T extends HTMLElement>(element: T | null, id: string): T {
  if (!element) throw new Error(`Panel element #${id} not found`);
  return element;
}

function getMessageParts(type: string) {
  if (type.startsWith('Request ')) {
    return { kind: 'Request', name: type.slice('Request '.length) || 'unknown' };
  }
  if (type.startsWith('Broadcast ')) {
    return { kind: 'Broadcast', name: type.slice('Broadcast '.length) || 'unknown' };
  }
  return { kind: 'Broadcast', name: type || 'unknown' };
}
