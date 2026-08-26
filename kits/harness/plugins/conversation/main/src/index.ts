declare const editor: any;

type AgentSource = 'harbors';
type ArchiveErrorCode = 'INVALID_CONVERSATION_ID' | 'CONVERSATION_NOT_FOUND' | 'CONVERSATION_ACTIVE'
  | 'ARCHIVE_NOT_FOUND' | 'ARCHIVE_CONFLICT' | 'ARCHIVE_FILE_INVALID'
  | 'ARCHIVE_TOMBSTONE_INVALID' | 'ARCHIVE_OPERATION_FAILED' | 'ARCHIVE_STATE_INCONSISTENT';
type BusinessResult<T> = { ok: true; value: T } | { ok: false; error: { code: ArchiveErrorCode; message: string } };

interface ConversationSummary {
  id: string; project?: string; title?: string; active?: boolean; createdAt?: string; updatedAt?: string;
  availability?: 'available' | 'unavailable'; errorCode?: string;
}
interface ArchivedConversationSummary {
  id: string; source: AgentSource; title: string; project?: string; createdAt?: string; updatedAt?: string;
  archivedAt: string; status: 'available' | 'unavailable'; errorCode?: string;
}
interface ConversationDraft { source: AgentSource; project?: string }
interface ConversationState {
  selectedConversationId: string | null; selectedProject?: string; draft: ConversationDraft | null;
  running: boolean; generation: string; revision: number;
}
type ConversationChangedPayload =
  | { action: 'create' | 'rename' | 'update' | 'restore'; id: string; conversation?: ConversationSummary }
  | { action: 'archive'; id: string; archived?: ArchivedConversationSummary };

const INITIAL_RETRY_DELAYS_MS = [25, 50, 100, 250, 500, 1000];
const ERROR_MESSAGES: Record<ArchiveErrorCode, string> = {
  INVALID_CONVERSATION_ID: '对话标识无效', CONVERSATION_NOT_FOUND: '对话不存在，请刷新后重试',
  CONVERSATION_ACTIVE: '对话仍在运行，请先停止后再归档', ARCHIVE_NOT_FOUND: '归档不存在，请刷新后重试',
  ARCHIVE_CONFLICT: '同一对话已存在，无法覆盖', ARCHIVE_FILE_INVALID: '归档文件已损坏，无法恢复',
  ARCHIVE_TOMBSTONE_INVALID: '归档记录不一致，无法恢复', ARCHIVE_OPERATION_FAILED: '归档操作失败，原状态已恢复，请重试',
  ARCHIVE_STATE_INCONSISTENT: '归档状态异常，已保留诊断证据',
};

let runtime: any;
let conversations: ConversationSummary[] = [];
let state: ConversationState = { selectedConversationId: null, draft: null, running: false, generation: '', revision: 0 };
let lifecycleGeneration = 0;
let activityEpoch = 0;
const mutationQueues = new Map<string, Promise<void>>();
let selectionSequence = 0;
let initializationBarrier: Promise<void> | null = null;

function createGeneration(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  const nonce = typeof randomUUID === 'function' ? randomUUID.call(globalThis.crypto) : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `conversation-${nonce}`;
}
function describeError(error: unknown): string { return error instanceof Error && error.message ? error.message : typeof error === 'string' ? error : '未知错误'; }
function isRunning(id: string | null): boolean { return Boolean(id && conversations.some((item) => item.id === id && item.active)); }
function isAvailable(value: ConversationSummary | undefined): value is ConversationSummary { return Boolean(value && value.availability !== 'unavailable'); }
function firstAvailable(): ConversationSummary | undefined { return conversations.find(isAvailable); }
function copyState(): ConversationState {
  const selectedProject = state.selectedConversationId ? conversations.find((item) => item.id === state.selectedConversationId)?.project : undefined;
  return { selectedConversationId: state.selectedConversationId, ...(selectedProject ? { selectedProject } : {}), draft: state.draft ? { ...state.draft } : null, running: isRunning(state.selectedConversationId), generation: state.generation, revision: state.revision };
}
function broadcastSelected(): ConversationState { const snapshot = copyState(); runtime?.message.broadcast('conversation.selected', snapshot); return snapshot; }
function updateState(selectedConversationId: string | null, draft: ConversationDraft | null): ConversationState {
  state = { selectedConversationId, draft: draft ? { ...draft } : null, running: isRunning(selectedConversationId), generation: state.generation, revision: state.revision + 1 };
  return broadcastSelected();
}
function normalizeConversation(value: unknown): ConversationSummary | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || !record.id) return null;
  return { id: record.id, ...(typeof record.project === 'string' ? { project: record.project } : {}), ...(typeof record.title === 'string' ? { title: record.title } : {}), ...(typeof record.active === 'boolean' ? { active: record.active } : {}), ...(typeof record.createdAt === 'string' ? { createdAt: record.createdAt } : {}), ...(typeof record.updatedAt === 'string' ? { updatedAt: record.updatedAt } : {}), ...(record.availability === 'available' || record.availability === 'unavailable' ? { availability: record.availability } : {}), ...(typeof record.errorCode === 'string' ? { errorCode: record.errorCode } : {}) };
}
function normalizeConversations(value: unknown): ConversationSummary[] {
  return Array.isArray(value) ? value.flatMap((item) => { const normalized = normalizeConversation(item); return normalized ? [normalized] : []; }) : [];
}
function normalizeArchived(value: unknown): ArchivedConversationSummary | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || !record.id || record.source !== 'harbors' || typeof record.title !== 'string' || typeof record.archivedAt !== 'string' || (record.status !== 'available' && record.status !== 'unavailable')) return null;
  return { id: record.id, source: 'harbors', title: record.title, archivedAt: record.archivedAt, status: record.status, ...(typeof record.project === 'string' ? { project: record.project } : {}), ...(typeof record.createdAt === 'string' ? { createdAt: record.createdAt } : {}), ...(typeof record.updatedAt === 'string' ? { updatedAt: record.updatedAt } : {}), ...(typeof record.errorCode === 'string' ? { errorCode: record.errorCode } : {}) };
}
function normalizeError(value: unknown): { code: ArchiveErrorCode; message: string } | null {
  if (!value || typeof value !== 'object') return null;
  const code = (value as Record<string, unknown>).code;
  return typeof code === 'string' && code in ERROR_MESSAGES ? { code: code as ArchiveErrorCode, message: ERROR_MESSAGES[code as ArchiveErrorCode] } : null;
}
function normalizeBusinessResult<T>(value: unknown, normalize: (input: unknown) => T | null): BusinessResult<T> {
  if (!value || typeof value !== 'object') throw new Error('[conversation] archive protocol unavailable');
  const record = value as Record<string, unknown>;
  if (record.ok === true) { const normalized = normalize(record.value); if (normalized === null) throw new Error('[conversation] archive protocol unavailable'); return { ok: true, value: normalized }; }
  if (record.ok === false) { const error = normalizeError(record.error); if (!error) throw new Error('[conversation] archive protocol unavailable'); return { ok: false, error }; }
  throw new Error('[conversation] archive protocol unavailable');
}
function applyArchive(id: string, archived?: ArchivedConversationSummary): void {
  const index = conversations.findIndex((item) => item.id === id);
  if (index < 0) return;
  const wasSelected = state.selectedConversationId === id && !state.draft;
  const previous = conversations[index];
  conversations = conversations.filter((item) => item.id !== id);
  if (!wasSelected) return;
  const next = conversations.slice(index).find(isAvailable) ?? conversations.slice(0, index).reverse().find(isAvailable);
  if (next) updateState(next.id, null);
  else updateState(null, { source: 'harbors', project: archived?.project || previous.project || process.cwd() });
}
function applyRestore(value: ConversationSummary): void {
  if (conversations.some((item) => item.id === value.id)) return;
  conversations.push(value);
  conversations.sort((a, b) => Date.parse(b.updatedAt || b.createdAt || '') - Date.parse(a.updatedAt || a.createdAt || ''));
}
function applyConversationChanged(payload: ConversationChangedPayload): void {
  activityEpoch += 1;
  const previousRunning = isRunning(state.selectedConversationId);
  if (payload.action === 'archive') applyArchive(payload.id, payload.archived ? normalizeArchived(payload.archived) ?? undefined : undefined);
  else if (payload.action === 'restore') { const conversation = normalizeConversation(payload.conversation); if (conversation) applyRestore(conversation); }
  else if (payload.action === 'create') {
    const conversation = normalizeConversation(payload.conversation);
    if (conversation && !conversations.some((item) => item.id === payload.id)) conversations.unshift(conversation);
    if (!state.draft && (!state.selectedConversationId || !isAvailable(conversations.find((item) => item.id === state.selectedConversationId)))) {
      updateState(firstAvailable()?.id ?? null, null);
      return;
    }
  }
  else { const conversation = normalizeConversation(payload.conversation); if (conversation) conversations = conversations.map((item) => item.id === payload.id ? { ...item, ...conversation } : item); }
  const nextRunning = isRunning(state.selectedConversationId);
  if (nextRunning !== previousRunning && state.selectedConversationId) { state = { ...state, running: nextRunning, revision: state.revision + 1 }; broadcastSelected(); }
}
async function initializeActivity(generation: number): Promise<void> {
  let retry = 0;
  while (generation === lifecycleGeneration && runtime) {
    const epoch = activityEpoch;
    try {
      const value = await runtime.message.request('agent', 'listConversations');
      if (generation !== lifecycleGeneration || !runtime) throw new Error('[conversation] plugin is not loaded');
      if (epoch !== activityEpoch) continue;
      conversations = normalizeConversations(value);
      const initial = firstAvailable();
      if (!state.draft && state.selectedConversationId && !isAvailable(conversations.find((item) => item.id === state.selectedConversationId))) updateState(initial?.id ?? null, null);
      else if (!state.draft && !state.selectedConversationId && initial) updateState(initial.id, null);
      return;
    } catch (error) {
      if (generation !== lifecycleGeneration || !runtime) throw new Error('[conversation] plugin is not loaded');
      if (retry >= INITIAL_RETRY_DELAYS_MS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, INITIAL_RETRY_DELAYS_MS[retry++]));
    }
  }
  throw new Error('[conversation] plugin is not loaded');
}
async function awaitInitialization(): Promise<void> { if (!runtime || !initializationBarrier) throw new Error('[conversation] plugin is not loaded'); await initializationBarrier; }
function enqueueMutation<T>(id: string, run: (currentRuntime: any, generation: number) => Promise<T>): Promise<T> {
  const generation = lifecycleGeneration;
  const previous = mutationQueues.get(id) || Promise.resolve();
  const task = previous.catch(() => undefined).then(async () => {
    if (generation !== lifecycleGeneration || !runtime) throw new Error('[conversation] plugin is not loaded');
    return run(runtime, generation);
  });
  const tail = task.then(() => undefined, () => undefined);
  mutationQueues.set(id, tail);
  void tail.finally(() => { if (mutationQueues.get(id) === tail) mutationQueues.delete(id); });
  return task;
}

editor.plugin.define({
  lifecycle: {
    load(ctx: any) {
      lifecycleGeneration += 1; runtime = ctx; conversations = []; activityEpoch = 0; mutationQueues.clear();
      state = { selectedConversationId: null, draft: null, running: false, generation: createGeneration(), revision: 0 };
      broadcastSelected();
      const generation = lifecycleGeneration;
      initializationBarrier = initializeActivity(generation);
      void initializationBarrier.catch((error) => {
        if (generation === lifecycleGeneration && runtime) console.error('[conversation] failed to initialize conversations:', describeError(error));
      });
    },
    unload() {
      lifecycleGeneration += 1; activityEpoch += 1; mutationQueues.clear(); selectionSequence += 1;
      runtime = null; initializationBarrier = null; conversations = [];
      state = { ...state, selectedConversationId: null, draft: null, running: false };
    },
  },
  methods: {
    onConversationChanged(value: unknown) {
      if (!value || typeof value !== 'object') return copyState();
      const payload = value as Partial<ConversationChangedPayload>;
      if (typeof payload.id !== 'string' || !payload.action) return copyState();
      applyConversationChanged(payload as ConversationChangedPayload); return copyState();
    },
    getState: copyState,
    async listArchivedConversations(): Promise<BusinessResult<ArchivedConversationSummary[]>> {
      const currentRuntime = runtime; if (!currentRuntime) throw new Error('[conversation] plugin is not loaded');
      const result = await currentRuntime.message.request('agent', 'listArchivedConversations');
      if (currentRuntime !== runtime) throw new Error('[conversation] plugin is not loaded');
      return normalizeBusinessResult(result, (input) => {
        if (!Array.isArray(input)) return null;
        const items = input.map(normalizeArchived);
        return items.some((item) => item === null) ? null : items as ArchivedConversationSummary[];
      });
    },
    async archiveConversation(id: string): Promise<BusinessResult<ArchivedConversationSummary>> {
      await awaitInitialization();
      if (typeof id !== 'string' || !id) return { ok: false, error: { code: 'INVALID_CONVERSATION_ID', message: ERROR_MESSAGES.INVALID_CONVERSATION_ID } };
      return enqueueMutation(id, async (currentRuntime, generation) => {
        if (!isAvailable(conversations.find((item) => item.id === id))) return { ok: false, error: { code: 'CONVERSATION_NOT_FOUND', message: ERROR_MESSAGES.CONVERSATION_NOT_FOUND } };
        const result = normalizeBusinessResult(await currentRuntime.message.request('agent', 'archiveConversation', id), normalizeArchived);
        if (result.ok && generation === lifecycleGeneration && currentRuntime === runtime) applyArchive(id, result.value);
        return result;
      });
    },
    async restoreConversation(id: string): Promise<BusinessResult<ConversationSummary>> {
      await awaitInitialization();
      if (typeof id !== 'string' || !id) return { ok: false, error: { code: 'INVALID_CONVERSATION_ID', message: ERROR_MESSAGES.INVALID_CONVERSATION_ID } };
      return enqueueMutation(id, async (currentRuntime, generation) => {
        const result = normalizeBusinessResult(await currentRuntime.message.request('agent', 'restoreConversation', id), normalizeConversation);
        if (result.ok && generation === lifecycleGeneration && currentRuntime === runtime) applyRestore(result.value);
        return result;
      });
    },
    async select(id: string | null, draft?: { project?: string }) {
      const command = ++selectionSequence; const currentRuntime = runtime; const generation = lifecycleGeneration; const epoch = activityEpoch;
      if (!currentRuntime) throw new Error('[conversation] plugin is not loaded');
      if (id === null) { const project = draft?.project || conversations.find((item) => item.id === state.selectedConversationId)?.project; return updateState(null, { source: 'harbors', project: project || process.cwd() }); }
      const refreshed = await currentRuntime.message.request('agent', 'listConversations');
      if (currentRuntime !== runtime || generation !== lifecycleGeneration) throw new Error('[conversation] plugin is not loaded');
      if (command !== selectionSequence) return copyState();
      if (epoch === activityEpoch) conversations = normalizeConversations(refreshed);
      if (!isAvailable(conversations.find((item) => item.id === id))) throw new Error('[conversation] conversation is unavailable');
      return updateState(id, null);
    },
  },
});
