import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import './index.css';

interface ConversationData {
  id: string;
  title: string;
  lastMessage?: string;
  preview?: string;
  source: 'codex' | 'harbors';
  project?: string;
}

interface ConversationDraft {
  source: 'codex' | 'harbors';
  project?: string;
}

interface ConversationUiState {
  selectedConversationId: string | null;
  draft: ConversationDraft | null;
  generation: string;
  revision: number;
}

const EMPTY_UI_STATE: ConversationUiState = {
  selectedConversationId: null,
  draft: null,
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
  const sequenceRef = useRef(0);
  const uiStateArrivalSequenceRef = useRef(0);
  const latestUiArrivalSequenceRef = useRef(-1);
  const latestUiGenerationRef = useRef<string | null>(null);
  const seenUiGenerationsRef = useRef(new Set<string>());
  const latestUiRevisionRef = useRef(-1);

  useEffect(() => {
    let disposed = false;
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
      const list = Array.isArray(value) ? (value as ConversationData[]) : [];
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
          && (state.draft.source === 'codex' || state.draft.source === 'harbors')
          ? { source: state.draft.source, ...(typeof state.draft.project === 'string' ? { project: state.draft.project } : {}) }
          : null,
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

    registerSetter('conversation.changed', (data: unknown) => {
      sequenceRef.current += 1;
      if (!disposed) applyList(data);
    });
    registerSetter('conversation.ui.changed', (data: unknown) => {
      sequenceRef.current += 1;
      if (!disposed) {
        if (applyUiState(data, ++uiStateArrivalSequenceRef.current)) setError(null);
      }
    });

    const requestId = sequenceRef.current;
    const initialUiRequestSequence = ++uiStateArrivalSequenceRef.current;
    Promise.all([
      requestWithRetry('加载对话列表', () => ctx.message.request('agent', 'listConversations')),
      requestWithRetry('加载会话状态', () => ctx.message.request('conversation-list', 'getConversationUiState')),
    ]).then(([listResult, uiStateResult]) => {
      if (disposed || listResult.disposed || uiStateResult.disposed) return;

      const errors = [listResult.error, uiStateResult.error].filter((value): value is string => Boolean(value));
      if (requestId === sequenceRef.current && !listResult.error) applyList(listResult.value);
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
      // 忽略初始化中的旧选择结果，避免它覆盖刚进入的草稿态。
      sequenceRef.current += 1;
      await ctx.message.request('conversation-list', 'startDraftConversation');
      setError(null);
    } catch (err) {
      console.error('Failed to create conversation:', describeError(err));
      setError(`新建对话失败：${describeError(err)}`);
    }
  };

  const handleSelect = async (id: string) => {
    try {
      await ctx.message.request('conversation-list', 'selectConversation', id);
      setError(null);
    } catch (err) {
      console.error('Failed to select conversation:', describeError(err));
      setError(`切换对话失败：${describeError(err)}`);
    }
  };

  const handleArchive = async (id: string, event: ReactMouseEvent) => {
    event.stopPropagation();
    try {
      await ctx.message.request('agent', 'deleteConversation', id);
      setError(null);
    } catch (err) {
      console.error('Failed to archive conversation:', describeError(err));
      setError(`归档对话失败：${describeError(err)}`);
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
          <button type="button" className="new-conversation-btn codex" onClick={handleNew} aria-label="新建对话">＋ 新对话</button>
        </div>
      </div>
      {error && <div className="conversation-list-error" role="alert">{error}</div>}
      <div className="conversation-list-body">
        {[...groups.entries()].map(([project, projectConversations]) => (
          <section key={project} className="project-group" aria-label={`${project} 项目会话`}>
            <div className="project-group-heading"><span>{project}</span><span>{projectConversations.length}</span></div>
            {projectConversations.map((conversation) => {
              const harbors = conversation.source === 'harbors';
              return (
                <article key={conversation.id} className={`conversation-card ${uiState.selectedConversationId === conversation.id ? 'active' : ''}`} role="button" tabIndex={0} onClick={() => handleSelect(conversation.id)} onKeyDown={(event) => { if (event.target !== event.currentTarget) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); handleSelect(conversation.id); } }}>
                  <div className={`source-mark ${harbors ? 'harbors' : 'codex'}`} aria-hidden="true">{harbors ? '⚓' : '⌘'}</div>
                  <div className="conversation-card-content">
                    <div className="conversation-card-title-row">
                      <span className="conversation-card-title">{conversation.title}</span>
                    </div>
                  </div>
                  <details className="conversation-menu" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                    <summary className="more-btn" aria-label={`更多操作：${conversation.title}`} aria-haspopup="menu" title="更多操作">•••</summary>
                    <div className="conversation-menu-popover" role="menu">
                      <button type="button" role="menuitem" onClick={(event) => handleArchive(conversation.id, event)}>归档</button>
                    </div>
                  </details>
                </article>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
