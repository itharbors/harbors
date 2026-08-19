declare const editor: any;

type AgentSource = 'harbors';

interface ConversationSummary {
  id: string;
  project?: string;
  title?: string;
  active?: boolean;
}

interface SelectDraftOptions {
  project?: string;
}

interface ConversationDraft {
  source: AgentSource;
  project?: string;
}

interface ConversationState {
  selectedConversationId: string | null;
  selectedProject?: string;
  draft: ConversationDraft | null;
  running: boolean;
  generation: string;
  revision: number;
}

type ConversationChangedAction = 'create' | 'delete' | 'rename' | 'update';

interface ConversationChangedPayload {
  action: ConversationChangedAction;
  id: string;
  conversation?: ConversationSummary;
}

let runtime: any;
let conversations: ConversationSummary[] = [];
let state: ConversationState = {
  selectedConversationId: null,
  draft: null,
  running: false,
  generation: '',
  revision: 0,
};
const INITIAL_RETRY_DELAYS_MS = [25, 50, 100, 250, 500, 1000];
let initializationTimer: ReturnType<typeof setTimeout> | null = null;
let initializationGeneration = 0;
let conversationSyncSequence = 0;
let selectionSequence = 0;
let lifecycleGeneration = 0;

function createGeneration(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  const nonce = typeof randomUUID === 'function'
    ? randomUUID.call(globalThis.crypto)
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `conversation-${nonce}`;
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object') {
    const record = error as { message?: unknown; error?: unknown; detail?: unknown };
    for (const value of [record.message, record.error, record.detail]) {
      if (typeof value === 'string' && value.trim()) return value;
    }
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== '{}') return serialized;
    } catch {
      // Ignore values that cannot be serialized.
    }
  }
  return '未知错误';
}

function isRunning(id: string | null): boolean {
  if (!id) return false;
  return conversations.some((conversation) => conversation.id === id && conversation.active);
}

function copyState(): ConversationState {
  const selectedProject = state.selectedConversationId
    ? conversations.find((conversation) => conversation.id === state.selectedConversationId)?.project
    : undefined;
  return {
    selectedConversationId: state.selectedConversationId,
    ...(selectedProject ? { selectedProject } : {}),
    draft: state.draft ? { ...state.draft } : null,
    running: isRunning(state.selectedConversationId),
    generation: state.generation,
    revision: state.revision,
  };
}

function broadcastSelected(): ConversationState {
  const snapshot = copyState();
  runtime?.message.broadcast('conversation.selected', snapshot);
  return snapshot;
}

function updateState(selectedConversationId: string | null, draft: ConversationDraft | null): ConversationState {
  state = {
    selectedConversationId,
    draft: draft ? { ...draft } : null,
    running: isRunning(selectedConversationId),
    generation: state.generation,
    revision: state.revision + 1,
  };
  return broadcastSelected();
}

function normalizeConversation(value: unknown): ConversationSummary | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { id?: unknown; project?: unknown; title?: unknown; active?: unknown };
  if (typeof record.id !== 'string' || record.id.length === 0) return null;
  return {
    id: record.id,
    ...(typeof record.project === 'string' ? { project: record.project } : {}),
    ...(typeof record.title === 'string' ? { title: record.title } : {}),
    ...(typeof record.active === 'boolean' ? { active: record.active } : {}),
  };
}

function normalizeConversations(value: unknown): ConversationSummary[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const conversation = normalizeConversation(item);
    return conversation ? [conversation] : [];
  });
}

function fallbackSelection(): string | null {
  return conversations[0]?.id || null;
}

function reconcileSelection(): void {
  if (state.draft) return;
  const selected = state.selectedConversationId;
  if (selected && conversations.some((conversation) => conversation.id === selected)) return;
  const fallback = fallbackSelection();
  if (selected !== fallback) updateState(fallback, null);
}

function applyConversationChanged(payload: ConversationChangedPayload): void {
  const previousRunning = isRunning(state.selectedConversationId);
  const previousSelected = state.selectedConversationId;
  const previousDraft = state.draft;
  const { action, id } = payload;
  if (action === 'create') {
    const conversation = normalizeConversation(payload.conversation);
    if (conversation && !conversations.some((item) => item.id === id)) {
      conversations.unshift(conversation);
    }
  } else if (action === 'delete') {
    conversations = conversations.filter((conversation) => conversation.id !== id);
  } else if (action === 'rename' || action === 'update') {
    const conversation = normalizeConversation(payload.conversation);
    if (conversation) {
      conversations = conversations.map((item) => item.id === id ? { ...item, ...conversation } : item);
    }
  }

  reconcileSelection();

  // If selection or draft changed, reconcileSelection already broadcast via updateState.
  if (state.selectedConversationId !== previousSelected || state.draft !== previousDraft) return;

  const nextRunning = isRunning(state.selectedConversationId);
  if (nextRunning !== previousRunning) {
    state = { ...state, running: nextRunning, revision: state.revision + 1 };
    broadcastSelected();
  }
}

function cancelInitialConversations(): void {
  initializationGeneration += 1;
  if (initializationTimer !== null) {
    clearTimeout(initializationTimer);
    initializationTimer = null;
  }
}

function requestInitialConversations(): void {
  cancelInitialConversations();
  const generation = initializationGeneration;
  let retryCount = 0;

  const request = () => {
    if (generation !== initializationGeneration || !runtime) return;

    const sequence = ++conversationSyncSequence;
    const currentRuntime = runtime;
    Promise.resolve()
      .then(() => {
        if (generation !== initializationGeneration || runtime !== currentRuntime) return undefined;
        return currentRuntime.message.request('agent', 'listConversations');
      })
      .then((value: unknown) => {
        if (generation !== initializationGeneration || !runtime) return;
        if (sequence < conversationSyncSequence) return;
        conversationSyncSequence = sequence;
        conversations = normalizeConversations(value);
        reconcileSelection();
      })
      .catch((error: unknown) => {
        if (generation !== initializationGeneration || !runtime) return;
        if (retryCount < INITIAL_RETRY_DELAYS_MS.length) {
          const delay = INITIAL_RETRY_DELAYS_MS[retryCount++];
          initializationTimer = setTimeout(() => {
            initializationTimer = null;
            request();
          }, delay);
          return;
        }
        console.error('[conversation] failed to initialize conversations:', describeError(error));
      });
  };

  request();
}

editor.plugin.define({
  lifecycle: {
    load(ctx: any) {
      lifecycleGeneration += 1;
      runtime = ctx;
      conversations = [];
      state = { selectedConversationId: null, draft: null, running: false, generation: createGeneration(), revision: 0 };
      broadcastSelected();
      requestInitialConversations();
    },
    unload() {
      lifecycleGeneration += 1;
      cancelInitialConversations();
      conversationSyncSequence += 1;
      selectionSequence += 1;
      runtime = null;
      conversations = [];
      state = { ...state, selectedConversationId: null, draft: null, running: false };
    },
  },
  methods: {
    onConversationChanged(value: unknown) {
      if (!value || typeof value !== 'object') return copyState();
      const payload = value as Partial<ConversationChangedPayload>;
      if (typeof payload.id !== 'string' || !payload.action) return copyState();
      applyConversationChanged(payload as ConversationChangedPayload);
      return copyState();
    },
    getState() {
      return copyState();
    },
    async select(id: string | null, draft?: SelectDraftOptions) {
      const commandSequence = ++selectionSequence;
      const sequence = ++conversationSyncSequence;
      const currentRuntime = runtime;
      const currentLifecycle = lifecycleGeneration;
      if (!currentRuntime) throw new Error('[conversation] plugin is not loaded');

      if (id === null) {
        const selectedProject = draft?.project || conversations.find(
          (conversation) => conversation.id === state.selectedConversationId,
        )?.project;
        return updateState(null, {
          source: 'harbors',
          project: selectedProject || process.cwd(),
        });
      }

      const refreshed = await currentRuntime.message.request('agent', 'listConversations');
      if (currentRuntime !== runtime || currentLifecycle !== lifecycleGeneration) {
        throw new Error('[conversation] plugin is not loaded');
      }
      if (sequence < conversationSyncSequence) return copyState();
      conversationSyncSequence = sequence;
      conversations = normalizeConversations(refreshed);
      if (commandSequence !== selectionSequence) return copyState();
      if (!conversations.some((conversation) => conversation.id === id)) {
        throw new Error('[conversation] conversation does not exist');
      }
      return updateState(id, null);
    },
  },
});
