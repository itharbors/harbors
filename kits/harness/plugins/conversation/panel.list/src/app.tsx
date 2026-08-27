import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import './index.css';

interface ConversationData {
  id: string;
  title: string;
  lastMessage?: string;
  preview?: string;
  source: 'harbors';
  availability?: 'available' | 'unavailable';
  errorCode?: string;
  project?: string;
  createdAt?: string;
  updatedAt?: string;
  /** 该会话是否正在执行 agent turn。 */
  active?: boolean;
}

interface ConversationDraft {
  source: 'harbors';
  project?: string;
}

interface ConversationUiState {
  selectedConversationId: string | null;
  draft: ConversationDraft | null;
  running: boolean;
  generation: string;
  revision: number;
}

const EMPTY_UI_STATE: ConversationUiState = {
  selectedConversationId: null,
  draft: null,
  running: false,
  generation: '',
  revision: 0,
};
const INITIAL_RETRY_DELAYS_MS = [25, 50, 100, 250, 500, 1000];

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

function projectLabel(project: string | undefined): string {
  if (!project || project === '未归类项目') return '未归类项目';
  if (project === 'Harbors') return 'Harbors Agent';
  const parts = project.split('/').filter(Boolean);
  return parts.length > 1 ? parts.slice(-2).join(' / ') : project;
}

function normalizeConversation(value: unknown): ConversationData | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<ConversationData>;
  if (typeof record.id !== 'string' || typeof record.title !== 'string') return null;
  return {
    id: record.id,
    title: record.title,
    ...(typeof record.lastMessage === 'string' ? { lastMessage: record.lastMessage } : {}),
    ...(typeof record.preview === 'string' ? { preview: record.preview } : {}),
    source: 'harbors',
    ...(record.availability === 'available' || record.availability === 'unavailable' ? { availability: record.availability } : {}),
    ...(typeof record.errorCode === 'string' ? { errorCode: record.errorCode } : {}),
    ...(typeof record.project === 'string' ? { project: record.project } : {}),
    ...(typeof record.createdAt === 'string' ? { createdAt: record.createdAt } : {}),
    ...(typeof record.updatedAt === 'string' ? { updatedAt: record.updatedAt } : {}),
    ...(typeof record.active === 'boolean' ? { active: record.active } : {}),
  };
}

function sortByUpdatedAt(values: ConversationData[]): ConversationData[] {
  return [...values].sort((left, right) => {
    const leftTime = Date.parse(left.updatedAt || left.createdAt || '');
    const rightTime = Date.parse(right.updatedAt || right.createdAt || '');
    return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
  });
}

function applyConversationChange(previous: ConversationData[], value: unknown): ConversationData[] {
  if (!value || typeof value !== 'object') return previous;
  const payload = value as { action?: string; id?: string; conversation?: unknown };
  if (typeof payload.id !== 'string' || !payload.action) return previous;
  const { action, id } = payload;
  if (action === 'create') {
    const conversation = normalizeConversation(payload.conversation);
    if (conversation && !previous.some((item) => item.id === id)) return [conversation, ...previous];
    return previous;
  }
  if (action === 'archive' || action === 'delete') return previous.filter((item) => item.id !== id);
  if (action === 'restore') {
    const conversation = normalizeConversation(payload.conversation);
    if (!conversation) return previous;
    const restored = previous.some((item) => item.id === id)
      ? previous.map((item) => item.id === id ? { ...item, ...conversation } : item)
      : [...previous, conversation];
    return sortByUpdatedAt(restored);
  }
  if (action === 'rename' || action === 'update') {
    const conversation = normalizeConversation(payload.conversation);
    if (!conversation) return previous;
    return previous.map((item) => item.id === id ? { ...item, ...conversation } : item);
  }
  return previous;
}

export default function App({
  ctx,
  registerSetter,
}: {
  ctx: any;
  registerSetter: (key: string, setter: (data: any) => void) => void;
}) {
  const [conversations, setConversations] = useState<ConversationData[]>([]);
  const [uiState, setUiState] = useState<ConversationUiState>(EMPTY_UI_STATE);
  const [error, setError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [archivingIds, setArchivingIds] = useState<Set<string>>(() => new Set());
  const uiStateArrivalSequenceRef = useRef(0);
  const latestUiArrivalSequenceRef = useRef(-1);
  const latestUiGenerationRef = useRef<string | null>(null);
  const seenUiGenerationsRef = useRef(new Set<string>());
  const latestUiRevisionRef = useRef(-1);

  useEffect(() => {
    let disposed = false;
    // 初始列表基线是否就绪；就绪前到达的变更先缓冲，基线建立后再按序重放，
    // 避免加载期间的广播落在空列表上而丢失（例如交互结束的 active=false）。
    let listReady = false;
    const pendingChanges: unknown[] = [];
    const pendingDelays = new Set<() => void>();
    const wait = (delay: number) => new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = () => {
        clearTimeout(timer);
        pendingDelays.delete(finish);
        resolve();
      };
      pendingDelays.add(finish);
      timer = setTimeout(finish, delay);
    });
    async function requestWithRetry<T>(label: string, request: () => Promise<T>) {
      let lastError: unknown = null;
      for (let attempt = 0; attempt <= INITIAL_RETRY_DELAYS_MS.length; attempt += 1) {
        if (disposed) return { disposed: true as const };
        try {
          return { value: await request() };
        } catch (err) {
          lastError = err;
          if (disposed) return { disposed: true as const };
          if (attempt === INITIAL_RETRY_DELAYS_MS.length) break;
          await wait(INITIAL_RETRY_DELAYS_MS[attempt]);
        }
      }
      return { error: `${label}：${describeError(lastError)}` };
    }
    const applyList = (value: unknown) => {
      const baseline = Array.isArray(value) ? (value as ConversationData[]) : [];
      // 用初始快照建立基线，再重放加载期间缓冲的变更，确保广播不被丢弃。
      const list = pendingChanges.reduce<ConversationData[]>((current, change) => applyConversationChange(current, change), baseline);
      pendingChanges.length = 0;
      listReady = true;
      setConversations(list);
      return list;
    };

    const applyUiState = (value: unknown, arrivalSequence = ++uiStateArrivalSequenceRef.current) => {
      if (!value || typeof value !== 'object') return false;
      const state = value as Partial<ConversationUiState>;
      const generation = typeof state.generation === 'string' && state.generation ? state.generation : null;
      if (!generation || arrivalSequence < latestUiArrivalSequenceRef.current) return false;
      const next: ConversationUiState = {
        selectedConversationId: typeof state.selectedConversationId === 'string' ? state.selectedConversationId : null,
        draft: state.draft && typeof state.draft === 'object'
          && state.draft.source === 'harbors'
          ? { source: state.draft.source, ...(typeof state.draft.project === 'string' ? { project: state.draft.project } : {}) }
          : null,
        running: typeof state.running === 'boolean' ? state.running : false,
        generation,
        revision: typeof state.revision === 'number' ? state.revision : 0,
      };
      const knownGeneration = seenUiGenerationsRef.current.has(generation);
      if (knownGeneration && latestUiGenerationRef.current !== generation) return false;
      if (latestUiGenerationRef.current === generation && next.revision <= latestUiRevisionRef.current) return false;
      seenUiGenerationsRef.current.add(generation);
      latestUiArrivalSequenceRef.current = arrivalSequence;
      latestUiGenerationRef.current = generation;
      latestUiRevisionRef.current = next.revision;
      setUiState(next);
      return true;
    };

    registerSetter('agent.conversation.changed', (data: unknown) => {
      if (disposed) return;
      // 基线未就绪前缓冲变更，就绪后直接增量应用。
      if (!listReady) { pendingChanges.push(data); return; }
      setConversations((previous) => applyConversationChange(previous, data));
    });
    registerSetter('conversation.selected', (data: unknown) => {
      if (!disposed) {
        if (applyUiState(data, ++uiStateArrivalSequenceRef.current)) setError(null);
      }
    });

    const initialUiRequestSequence = ++uiStateArrivalSequenceRef.current;
    Promise.all([
      requestWithRetry('加载对话列表', () => ctx.message.request('agent', 'listConversations')),
      requestWithRetry('加载会话状态', () => ctx.message.request('conversation', 'getState')),
    ]).then(([listResult, uiStateResult]) => {
      if (disposed || listResult.disposed || uiStateResult.disposed) return;

      const errors = [listResult.error, uiStateResult.error].filter((value): value is string => Boolean(value));
      // 无论初始列表成功或失败都建立基线并放开缓冲，避免加载失败后广播被永久吞掉。
      applyList(listResult.error ? [] : listResult.value);
      if (!uiStateResult.error) applyUiState(uiStateResult.value, initialUiRequestSequence);
      if (errors.length > 0) {
        console.error('Failed to load conversations:', errors.join('；'));
        setError(`加载对话列表失败：${errors.join('；')}`);
      } else {
        setError(null);
      }
    });

    return () => {
      disposed = true;
      pendingDelays.forEach((finish) => finish());
      pendingDelays.clear();
    };
  }, [ctx, registerSetter]);

  const handleNew = async () => {
    try {
      // 草稿态由 conversation.selected 的 generation/revision 去重保护，旧的初始状态不会覆盖它。
      await ctx.message.request('conversation', 'select', null);
      setError(null);
    } catch (err) {
      console.error('Failed to create conversation:', describeError(err));
      setError(`新建对话失败：${describeError(err)}`);
    }
  };

  const handleSelect = async (id: string) => {
    try {
      await ctx.message.request('conversation', 'select', id);
      setError(null);
    } catch (err) {
      console.error('Failed to select conversation:', describeError(err));
      setError(`切换对话失败：${describeError(err)}`);
    }
  };

  const handleArchive = async (id: string, event: ReactMouseEvent) => {
    event.stopPropagation();
    if (archivingIds.has(id)) return;
    setArchivingIds((current) => new Set(current).add(id));
    try {
      const result = await ctx.message.request('conversation', 'archiveConversation', id) as {
        ok?: boolean;
        value?: { id?: string };
        error?: { message?: string };
      };
      if (result?.ok !== true) {
        setError(`归档对话失败：${result?.error?.message || '归档请求失败，请重试'}`);
        return;
      }
      const archivedId = typeof result.value?.id === 'string' ? result.value.id : id;
      setConversations((previous) => applyConversationChange(previous, { action: 'archive', id: archivedId }));
      setError(null);
    } catch (err) {
      console.error('Failed to archive conversation:', describeError(err));
      setError(`归档服务暂不可用：${describeError(err)}`);
    } finally {
      setArchivingIds((current) => { const next = new Set(current); next.delete(id); return next; });
    }
  };

  const startRename = (conversation: ConversationData, event: ReactMouseEvent) => {
    event.stopPropagation();
    // 关闭承载菜单的 details。
    (event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open');
    setRenamingId(conversation.id);
    setRenameValue(conversation.title);
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameValue('');
  };

  const commitRename = async (id: string) => {
    const nextTitle = renameValue.trim();
    const current = conversations.find((conversation) => conversation.id === id);
    if (!nextTitle || nextTitle === current?.title) {
      cancelRename();
      return;
    }
    try {
      await ctx.message.request('agent', 'renameConversation', id, nextTitle);
      setError(null);
    } catch (err) {
      console.error('Failed to rename conversation:', describeError(err));
      setError(`重命名对话失败：${describeError(err)}`);
    } finally {
      cancelRename();
    }
  };

  const groups = new Map<string, ConversationData[]>();
  for (const conversation of conversations) {
    const project = projectLabel(conversation.project);
    const group = groups.get(project) || [];
    group.push(conversation);
    groups.set(project, group);
  }

  return (
    <div className="conversation-list-panel">
      <div className="conversation-list-header">
        <div className="conversation-list-eyebrow">项目与会话</div>
        <div className="new-conversation-actions">
          <button type="button" className="new-conversation-btn" onClick={handleNew} aria-label="新建对话">＋ 新对话</button>
        </div>
      </div>
      {error && <div className="conversation-list-error" role="alert">{error}</div>}
      <div className="conversation-list-body">
        {[...groups.entries()].map(([project, projectConversations]) => (
          <section key={project} className="project-group" aria-label={`${project} 项目会话`}>
            <div className="project-group-heading"><span>{project}</span><span>{projectConversations.length}</span></div>
            {projectConversations.map((conversation) => {
              const isRenaming = renamingId === conversation.id;
              const unavailable = conversation.availability === 'unavailable';
              return (
                <article key={conversation.id} className={`conversation-card ${uiState.selectedConversationId === conversation.id ? 'active' : ''} ${unavailable ? 'unavailable' : ''}`} role="button" aria-disabled={unavailable || undefined} tabIndex={unavailable ? -1 : 0} onClick={() => { if (!unavailable && !isRenaming) handleSelect(conversation.id); }} onKeyDown={(event) => { if (unavailable || event.target !== event.currentTarget) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); handleSelect(conversation.id); } }}>
                  <div className="conversation-card-content">
                    <div className="conversation-card-title-row">
                      {isRenaming ? (
                        <input
                          className="conversation-rename-input"
                          value={renameValue}
                          autoFocus
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => setRenameValue(event.target.value)}
                          onKeyDown={(event) => {
                            event.stopPropagation();
                            if (event.key === 'Enter') { event.preventDefault(); void commitRename(conversation.id); }
                            else if (event.key === 'Escape') { event.preventDefault(); cancelRename(); }
                          }}
                          onBlur={() => void commitRename(conversation.id)}
                          aria-label="重命名对话"
                        />
                      ) : (
                        <span className="conversation-card-title">{conversation.title}</span>
                      )}
                      {unavailable && <span className="conversation-unavailable">数据损坏，暂不可用</span>}
                    </div>
                  </div>
                  {conversation.active && (
                    <span className="conversation-spinner" role="status" aria-label="正在执行" title="正在执行…" />
                  )}
                  {!unavailable && <details className="conversation-menu" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                    <summary className="more-btn" aria-label={`更多操作：${conversation.title}`} aria-haspopup="menu" title="更多操作">•••</summary>
                    <div className="conversation-menu-popover" role="menu">
                      <button type="button" role="menuitem" onClick={(event) => startRename(conversation, event)}>重命名</button>
                      <button type="button" role="menuitem" disabled={archivingIds.has(conversation.id)} aria-busy={archivingIds.has(conversation.id)} onClick={(event) => handleArchive(conversation.id, event)}>{archivingIds.has(conversation.id) ? '正在归档…' : '归档'}</button>
                    </div>
                  </details>}
                </article>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
