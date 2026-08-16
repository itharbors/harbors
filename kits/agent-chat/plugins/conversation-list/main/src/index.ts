declare const editor: any;

type AgentSource = 'codex' | 'harbors';

interface ConversationSummary {
  id: string;
  project?: string;
}

interface ConversationDraft {
  source: AgentSource;
  project?: string;
}

interface ConversationUiState {
  selectedConversationId: string | null;
  draft: ConversationDraft | null;
  generation: string;
  revision: number;
}

let runtime: any;
let conversations: ConversationSummary[] = [];
let uiState: ConversationUiState = {
  selectedConversationId: null,
  draft: null,
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
  return `conversation-list-${nonce}`;
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

function copyUiState(): ConversationUiState {
  return {
    selectedConversationId: uiState.selectedConversationId,
    draft: uiState.draft ? { ...uiState.draft } : null,
    generation: uiState.generation,
    revision: uiState.revision,
  };
}

function broadcastUiState(): ConversationUiState {
  const snapshot = copyUiState();
  runtime?.message.broadcast('conversation.ui.changed', snapshot);
  return snapshot;
}

function updateUiState(selectedConversationId: string | null, draft: ConversationDraft | null): ConversationUiState {
  uiState = {
    selectedConversationId,
    draft: draft ? { ...draft } : null,
    generation: uiState.generation,
    revision: uiState.revision + 1,
  };
  return broadcastUiState();
}

function normalizeConversations(value: unknown): ConversationSummary[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as { id?: unknown; project?: unknown };
    return typeof record.id === 'string' && record.id.length > 0
      ? [{ id: record.id, ...(typeof record.project === 'string' ? { project: record.project } : {}) }]
      : [];
  });
}

function reconcileUiState(value: unknown, sequence = conversationSyncSequence + 1): boolean {
  if (sequence < conversationSyncSequence) return false;
  conversationSyncSequence = sequence;
  conversations = normalizeConversations(value);
  if (uiState.draft) return true;

  const selected = uiState.selectedConversationId;
  if (selected && conversations.some((conversation) => conversation.id === selected)) return true;

  const fallback = conversations[0]?.id || null;
  if (selected !== fallback || uiState.draft !== null) updateUiState(fallback, null);
  return true;
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
        reconcileUiState(value, sequence);
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
        console.error('[conversation-list] failed to initialize UI state:', describeError(error));
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
      uiState = { selectedConversationId: null, draft: null, generation: createGeneration(), revision: 0 };
      broadcastUiState();
      requestInitialConversations();
    },
    unload() {
      lifecycleGeneration += 1;
      cancelInitialConversations();
      conversationSyncSequence += 1;
      selectionSequence += 1;
      runtime = null;
      conversations = [];
      uiState = { ...uiState, selectedConversationId: null, draft: null };
    },
  },
  methods: {
    onAgentConversationChanged(value: unknown) {
      reconcileUiState(value);
      return copyUiState();
    },
    getConversationUiState() {
      return copyUiState();
    },
    async selectConversation(id: string) {
      const commandSequence = ++selectionSequence;
      const sequence = ++conversationSyncSequence;
      const currentRuntime = runtime;
      const currentLifecycle = lifecycleGeneration;
      if (!currentRuntime) throw new Error('[conversation-list] plugin is not loaded');

      const refreshed = await currentRuntime.message.request('agent', 'listConversations');
      if (currentRuntime !== runtime || currentLifecycle !== lifecycleGeneration) {
        throw new Error('[conversation-list] plugin is not loaded');
      }
      reconcileUiState(refreshed, sequence);
      if (commandSequence !== selectionSequence) return copyUiState();
      if (!conversations.some((conversation) => conversation.id === id)) {
        throw new Error('[conversation-list] conversation does not exist');
      }
      return updateUiState(id, null);
    },
    startDraftConversation(source: AgentSource = 'codex', project?: string) {
      if (source !== 'codex' && source !== 'harbors') {
        throw new Error('[conversation-list] invalid conversation source');
      }
      selectionSequence += 1;
      const selectedProject = conversations.find(
        (conversation) => conversation.id === uiState.selectedConversationId,
      )?.project;
      return updateUiState(null, {
        source,
        project: project || selectedProject || process.cwd(),
      });
    },
  },
});
