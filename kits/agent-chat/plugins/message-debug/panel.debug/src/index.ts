type PanelContext = {
  message: {
    request(plugin: string, name: string, ...args: unknown[]): Promise<unknown>;
  };
};

type PanelDefinition = {
  mount?(ctx: PanelContext): void | Promise<void>;
  methods?: Record<string, (...args: unknown[]) => unknown>;
};

const count = document.getElementById('message-count');
const updated = document.getElementById('message-updated');
const messagesContainer = document.getElementById('messages');

const definition: PanelDefinition = {
  async mount(ctx) {
    try {
      const snapshot = await ctx.message.request('message-debug', 'getSnapshot');
      renderSnapshot(snapshot as MessageSnapshot);
    } catch (err) {
      renderError(err);
    }
  },
  methods: {
    onMessagesChanged(messages: unknown) {
      renderSnapshot({
        timestamp: Date.now(),
        messages,
      });
      return messages;
    },
  },
};

export default definition;

type MessageSnapshot = {
  timestamp?: number;
  messages?: unknown;
};

type RuntimeMessage = {
  id?: string | number;
  type?: string;
  payload?: unknown;
};

type RenderedMessage = {
  key: string;
  message: RuntimeMessage;
};

const BOTTOM_THRESHOLD = 12;
let renderedMessages: RenderedMessage[] = [];
let hasRenderedSnapshot = false;
const expandedMessageKeys = new Set<string>();

function requireElement<T extends HTMLElement>(element: T | null, id: string): T {
  if (!element) throw new Error(`Panel element #${id} not found`);
  return element;
}

function renderSnapshot(snapshot: MessageSnapshot = {}) {
  const countElement = requireElement(count, 'message-count');
  const updatedElement = requireElement(updated, 'message-updated');
  const container = requireElement(messagesContainer, 'messages');
  const messages = Array.isArray(snapshot.messages) ? snapshot.messages as RuntimeMessage[] : [];
  const nextMessages = createRenderedMessages(messages);
  const shouldFollowLatest = !hasRenderedSnapshot || isAtBottom(container);

  countElement.textContent = `${messages.length} ${messages.length === 1 ? 'message' : 'messages'}`;
  updatedElement.textContent = snapshot.timestamp ? new Date(snapshot.timestamp).toLocaleTimeString() : 'unknown';

  if (messages.length === 0) {
    if (renderedMessages.length !== 0 || container.childElementCount !== 1 || !container.querySelector('.empty')) {
      container.replaceChildren(createEmptyState());
    }
    renderedMessages = [];
    expandedMessageKeys.clear();
    hasRenderedSnapshot = true;
    if (shouldFollowLatest) scrollToLatest(container);
    return;
  }

  if (isAppendOnly(renderedMessages, nextMessages)) {
    if (renderedMessages.length === 0) container.replaceChildren();
    appendMessageRows(container, nextMessages.slice(renderedMessages.length));
  } else {
    const fragment = document.createDocumentFragment();
    for (const entry of nextMessages) fragment.append(createMessageRow(entry));
    container.replaceChildren(fragment);
  }

  renderedMessages = nextMessages;
  hasRenderedSnapshot = true;
  if (shouldFollowLatest) scrollToLatest(container);
}

function createRenderedMessages(messages: RuntimeMessage[]): RenderedMessage[] {
  const occurrences = new Map<string, number>();
  return messages.map((message, index) => {
    const identity = message.id !== undefined
      ? `id:${String(message.id)}`
      : `value:${message.type || 'unknown'}\u0000${stringifyPayload(message.payload, false)}`;
    const occurrence = occurrences.get(identity) || 0;
    occurrences.set(identity, occurrence + 1);
    return { key: `${identity}\u0000${occurrence}\u0000${index}`, message };
  });
}

function isAppendOnly(previous: RenderedMessage[], next: RenderedMessage[]): boolean {
  if (next.length < previous.length) return false;
  return previous.every((entry, index) => entry.key === next[index]?.key);
}

function appendMessageRows(container: HTMLElement, entries: RenderedMessage[]): void {
  if (entries.length === 0) return;
  const fragment = document.createDocumentFragment();
  for (const entry of entries) fragment.append(createMessageRow(entry));
  container.append(fragment);
}

function createMessageRow(entry: RenderedMessage): HTMLElement {
  const { key, message } = entry;
  const row = document.createElement('div');
  row.className = 'message';
  row.dataset.messageKey = key;

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
  const messageParts = getMessageParts(message.type || 'unknown');

  const type = document.createElement('div');
  type.className = 'message-type';
  type.textContent = messageParts.kind;

  const name = document.createElement('div');
  name.className = 'message-name';
  name.title = messageParts.name;
  name.textContent = messageParts.name;

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

  toggle.addEventListener('click', () => setExpanded(!row.classList.contains('expanded')));

  detail.append(payload);
  summary.append(type, name);
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

function isAtBottom(container: HTMLElement): boolean {
  return container.scrollTop + container.clientHeight >= container.scrollHeight - BOTTOM_THRESHOLD;
}

function scrollToLatest(container: HTMLElement): void {
  container.scrollTop = container.scrollHeight;
}

function renderError(err: unknown) {
  const countElement = requireElement(count, 'message-count');
  const updatedElement = requireElement(updated, 'message-updated');
  const container = requireElement(messagesContainer, 'messages');
  countElement.textContent = 'error';
  updatedElement.textContent = new Date().toLocaleTimeString();

  const error = document.createElement('div');
  error.className = 'error';
  error.textContent = err instanceof Error ? err.message : String(err);
  container.replaceChildren(error);
  renderedMessages = [];
  hasRenderedSnapshot = false;
  expandedMessageKeys.clear();
}

function stringifyPayload(payload: unknown, pretty: boolean) {
  if (payload === undefined) return 'undefined';
  if (payload === null) return 'null';
  if (typeof payload === 'string') return payload;
  return JSON.stringify(payload, null, pretty ? 2 : 0);
}

function getMessageParts(type: string) {
  if (type.startsWith('Request ')) {
    return {
      kind: 'Request',
      name: type.slice('Request '.length) || 'unknown',
    };
  }
  if (type.startsWith('Broadcast ')) {
    return {
      kind: 'Broadcast',
      name: type.slice('Broadcast '.length) || 'unknown',
    };
  }
  return {
    kind: 'Broadcast',
    name: type || 'unknown',
  };
}
