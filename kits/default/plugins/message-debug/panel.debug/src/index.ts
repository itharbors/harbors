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
      const snapshot = await ctx.message.request('@itharbors/message-debug', 'getSnapshot');
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
  type?: string;
  payload?: unknown;
};

function requireElement<T extends HTMLElement>(element: T | null, id: string): T {
  if (!element) throw new Error(`Panel element #${id} not found`);
  return element;
}

function renderSnapshot(snapshot: MessageSnapshot = {}) {
  const countElement = requireElement(count, 'message-count');
  const updatedElement = requireElement(updated, 'message-updated');
  const container = requireElement(messagesContainer, 'messages');
  const messages = Array.isArray(snapshot.messages) ? snapshot.messages as RuntimeMessage[] : [];
  countElement.textContent = `${messages.length} ${messages.length === 1 ? 'message' : 'messages'}`;
  updatedElement.textContent = snapshot.timestamp ? new Date(snapshot.timestamp).toLocaleTimeString() : 'unknown';
  container.innerHTML = '';

  if (messages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No runtime messages captured yet.';
    container.append(empty);
    return;
  }

  for (const message of messages.slice().reverse()) {
    const row = document.createElement('div');
    row.className = 'message';

    const rowHeader = document.createElement('div');
    rowHeader.className = 'message-row';

    const toggle = document.createElement('button');
    toggle.className = 'toggle';
    toggle.type = 'button';
    toggle.setAttribute('aria-label', 'Toggle message detail');
    toggle.setAttribute('aria-expanded', 'false');

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

    toggle.addEventListener('click', () => {
      const expanded = row.classList.toggle('expanded');
      toggle.setAttribute('aria-expanded', String(expanded));
    });

    detail.append(payload);
    summary.append(type, name);
    rowHeader.append(toggle, summary);
    row.append(rowHeader, detail);
    container.append(row);
  }
}

function renderError(err: unknown) {
  const countElement = requireElement(count, 'message-count');
  const updatedElement = requireElement(updated, 'message-updated');
  const container = requireElement(messagesContainer, 'messages');
  countElement.textContent = 'error';
  updatedElement.textContent = new Date().toLocaleTimeString();
  container.innerHTML = '';

  const error = document.createElement('div');
  error.className = 'error';
  error.textContent = err instanceof Error ? err.message : String(err);
  container.append(error);
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
