import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { acceptConversationUiState, createConversationUiStateGate } from './ui-state-gate.js';
import { parseTraceEvents, groupEntriesByTurn, type ToolProcessEntry } from './trace-events.js';
import './index.css';

// 配置 marked：启用 GFM（表格、删除线、任务列表），换行符转为 <br>
marked.setOptions({ gfm: true, breaks: true });

function MarkdownMessage({ content }: { content: string }) {
  const html = DOMPurify.sanitize(marked.parse(content, { async: false }) as string);
  return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
}

type Source = 'codex' | 'harbors';
interface MessageData { id: string; role: 'user' | 'assistant'; content: string; }
interface ConversationData { id: string; }
interface DraftData { source?: Source; project?: string; }
interface ConversationUiState { selectedConversationId?: string | null; draft?: DraftData | null; generation?: string; revision?: number; }
interface SelectOption { id: string; name: string; description?: string; }
interface ModelOption extends SelectOption { reasoningEfforts?: SelectOption[]; serviceTiers?: SelectOption[]; defaultReasoningEffort?: string; defaultServiceTier?: string; }
interface TurnOptions { model?: string; reasoningEffort?: string; serviceTier?: string; }
interface ContextUsage { model?: string; contextWindow: number; usedTokens: number; usageRatio: number; estimated?: boolean; }
interface AgentOptionsResponse { models?: ModelOption[]; defaultModel?: string; defaultReasoningEffort?: string; defaultServiceTier?: string; selectedModel?: string; selectedReasoningEffort?: string; selectedServiceTier?: string; selection?: TurnOptions; contextUsage?: ContextUsage; configurationError?: string; }
type PermissionOutcome = 'allowed-once' | 'rejected';
interface PermissionRequest { requestId: string; conversationId: string; turn: number; step: number; toolName: string; currentMode: string; requestedMode?: string; justification?: string; }
interface ProgressStatus { phase?: string; message?: string; turn?: number; step?: number; contextUsage?: ContextUsage; }
const REQUEST_RETRY_DELAYS = [0, 100, 250, 500, 1000];

function sourceFromId(id: string): Source { return id.startsWith('harbors:') ? 'harbors' : 'codex'; }
function fallbackModel(source: Source): string { return source === 'harbors' ? 'HubBert Relay' : 'Codex 默认模型'; }
function turnOptionsFor(model: string, reasoningEffort: string, serviceTier: string): TurnOptions {
  return { ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}), ...(serviceTier ? { serviceTier } : {}) };
}
function optionValue(options: SelectOption[] | undefined, selected: string | undefined, fallback: string | undefined): string {
  return selected || fallback || options?.[0]?.id || '';
}
function readAgentOptions(value: unknown): { models: ModelOption[]; selection: TurnOptions; contextUsage: ContextUsage | null; configurationError: string | null } {
  const typed = value as AgentOptionsResponse | null;
  const models = Array.isArray(typed?.models) ? typed.models : [];
  const model = typed?.selection?.model || typed?.selectedModel || typed?.defaultModel || models[0]?.id || '';
  const selectedModel = models.find((item) => item.id === model);
  return {
    models,
    selection: {
      model,
      reasoningEffort: optionValue(selectedModel?.reasoningEfforts, typed?.selection?.reasoningEffort || typed?.selectedReasoningEffort, selectedModel?.defaultReasoningEffort || typed?.defaultReasoningEffort),
      serviceTier: optionValue(selectedModel?.serviceTiers, typed?.selection?.serviceTier || typed?.selectedServiceTier, selectedModel?.defaultServiceTier || typed?.defaultServiceTier),
    },
    contextUsage: readContextUsage(typed?.contextUsage),
    configurationError: typed?.configurationError || null,
  };
}
function readableErrorMessage(value: unknown, seen = new Set<object>()): string {
  if (value instanceof Error) return value.message || value.name;
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '未知错误';
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  const record = value as Record<string, unknown>;
  for (const key of ['message', 'error', 'details', 'reason', 'msg']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
    if (candidate && typeof candidate === 'object') {
      const nested = readableErrorMessage(candidate, seen);
      if (nested && nested !== '[Circular]') return nested;
    }
  }

  try {
    const stringifySeen = new WeakSet<object>();
    const serialized = JSON.stringify(value, (_key, nested) => {
      if (typeof nested === 'object' && nested !== null) {
        if (stringifySeen.has(nested)) return '[Circular]';
        stringifySeen.add(nested);
      }
      if (typeof nested === 'function') return '[Function]';
      if (typeof nested === 'symbol') return nested.toString();
      if (typeof nested === 'bigint') return nested.toString();
      return nested;
    });
    return serialized || '未知错误';
  } catch {
    return '无法解析错误对象';
  }
}

function logError(prefix: string, error: unknown): void {
  console.error(`${prefix}: ${readableErrorMessage(error)}`);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function requestWithRetry(ctx: any, plugin: string, method: string, ...args: unknown[]): Promise<unknown> {
  let lastError: unknown;
  for (const delay of REQUEST_RETRY_DELAYS) {
    if (delay > 0) await wait(delay);
    try {
      return await ctx.message.request(plugin, method, ...args);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`请求失败：${plugin}.${method}`);
}

function sendErrorMessage(error: unknown): string {
  const message = readableErrorMessage(error);
  if (message.includes('already has an active writer') || message.includes('thread-store conflict')) {
    return '此 Codex 会话正由桌面 Codex 占用，Kit 只能查看历史，无法向同一会话写入。请点击左侧“新对话”创建一个可发送的 Kit Codex 会话，或改用 HubBert。';
  }
  return `消息发送失败：${message}`;
}

function readContextUsage(value: unknown): ContextUsage | null {
  if (!value || typeof value !== 'object') return null;
  const usage = value as Partial<ContextUsage>;
  if (!Number.isFinite(usage.contextWindow) || !Number.isFinite(usage.usedTokens) || !Number.isFinite(usage.usageRatio) || usage.contextWindow! <= 0) return null;
  return {
    model: typeof usage.model === 'string' ? usage.model : undefined,
    contextWindow: usage.contextWindow!,
    usedTokens: Math.max(0, usage.usedTokens!),
    usageRatio: Math.max(0, Math.min(1, usage.usageRatio!)),
    ...(usage.estimated !== undefined ? { estimated: Boolean(usage.estimated) } : {}),
  };
}

function ContextRing({ ratio, tokens, max }: { ratio: number; tokens: number; max: number }) {
  const r = 14;
  const circumference = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, ratio));
  const offset = circumference * (1 - clamped);
  const color = clamped >= 0.9 ? '#e88a8a' : clamped >= 0.7 ? '#e8c87a' : '#7db4ff';
  const percent = Math.round(clamped * 100);
  const title = max > 0 ? `上下文：${tokens} / ${max} tokens（${percent}%）` : `上下文：${percent}%`;
  return (
    <div className="context-ring" role="img" aria-label={title} title={title}>
      <svg width="36" height="36" viewBox="0 0 36 36">
        <circle cx="18" cy="18" r={r} fill="none" stroke="#3a4351" strokeWidth="3" />
        <circle
          cx="18" cy="18" r={r} fill="none" stroke={color} strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform="rotate(-90 18 18)"
          style={{ transition: 'stroke-dashoffset .3s ease, stroke .3s ease' }}
        />
      </svg>
      <span className="context-ring-label">{percent}%</span>
    </div>
  );
}

function ToolProcessCard({ entry }: { entry: ToolProcessEntry }) {
  const [expanded, setExpanded] = useState(false);
  const hasResult = entry.result !== undefined;
  const statusLabel = entry.isError ? '已失败' : hasResult ? '已完成' : '处理中';
  const statusClass = entry.isError ? 'error' : hasResult ? 'success' : 'pending';
  const toggle = () => setExpanded((value) => !value);
  return (
    <div className={`tool-process-card ${entry.isError ? 'error' : ''}`}>
      <div
        className="tool-process-header"
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle();
          }
        }}
      >
        <span className={`tool-status ${statusClass}`}>{statusLabel}</span>
        <span className="tool-name">{entry.name}</span>
      </div>
      {expanded && (
        <>
          {entry.arguments && (
            <div className="tool-arguments">
              <div className="tool-section-title">参数</div>
              <pre><code>{entry.arguments}</code></pre>
            </div>
          )}
          <div className="tool-result">
            {hasResult ? (
              <pre><code>{entry.result}</code></pre>
            ) : (
              <span className="tool-result-pending">处理中…</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function PermissionRequestCard({ request, resolving, onResolve }: { request: PermissionRequest; resolving: boolean; onResolve: (outcome: PermissionOutcome) => void; }) {
  const modeLabel = (mode?: string): string => ({
    'read-only': '只读',
    'workspace-write': '工作区可写',
    'danger-full-access': '完全访问',
  }[mode || ''] || mode || '未说明');
  return (
    <div className="permission-card">
      <div className="permission-card-header">
        <span className="permission-title">需要权限确认</span>
        <span className="permission-status">等待处理</span>
      </div>
      <div className="permission-card-tool">工具：<strong>{request.toolName}</strong></div>
      <div className="permission-card-modes">当前：{modeLabel(request.currentMode)} → 请求：{modeLabel(request.requestedMode)}</div>
      {request.justification && <p className="permission-card-justification">{request.justification}</p>}
      <div className="permission-card-actions">
        <button type="button" onClick={() => onResolve('rejected')} disabled={resolving}>拒绝</button>
        <button type="button" className="approve" onClick={() => onResolve('allowed-once')} disabled={resolving}>允许一次</button>
      </div>
    </div>
  );
}

export default function App({ ctx, registerSetter }: { ctx: any; registerSetter: (key: string, setter: (data: any) => void) => void; }) {
  const [messages, setMessages] = useState<MessageData[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [source, setSource] = useState<Source>('codex');
  const [draft, setDraft] = useState(false);
  const [project, setProject] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('');
  const [serviceTier, setServiceTier] = useState('');
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [configurationError, setConfigurationError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  const [toolEntries, setToolEntries] = useState<ToolProcessEntry[]>([]);
  const [localProcessEntries, setLocalProcessEntries] = useState<ToolProcessEntry[]>([]);
  const [permissionRequests, setPermissionRequests] = useState<PermissionRequest[]>([]);
  const [resolvingPermissionId, setResolvingPermissionId] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const loadSeqRef = useRef(0);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const shouldFollowLatestRef = useRef(true);
  const uiStateSequenceRef = useRef(0);
  const uiStateGateRef = useRef(createConversationUiStateGate());
  const applyUiStateRef = useRef<(value: unknown, sequence?: number) => void>(() => undefined);
  const sendingRef = useRef(false);
  const pendingConversationIdRef = useRef<string | null>(null);
  const stopRequestedRef = useRef(false);
  const traceRequestSeqRef = useRef(0);
  const permissionRequestSeqRef = useRef(0);
  const loadTrace = async (id: string, seq: number): Promise<void> => {
    const requestSeq = ++traceRequestSeqRef.current;
    try {
      const events = await requestWithRetry(ctx, 'agent', 'getConversationTrace', id);
      if (seq !== loadSeqRef.current || requestSeq !== traceRequestSeqRef.current) return;
      const list = Array.isArray(events) ? events : [];
      const entries = parseTraceEvents(list as any[]);
      setToolEntries(entries);
    } catch (err) {
      if (seq === loadSeqRef.current && requestSeq === traceRequestSeqRef.current) {
        logError('加载轨迹失败', err);
      }
    }
  };
  const applyAgentOptions = (value: unknown): void => {
    const options = readAgentOptions(value);
    setModels(options.models);
    setModel(options.selection.model || '');
    setReasoningEffort(options.selection.reasoningEffort || '');
    setServiceTier(options.selection.serviceTier || '');
    setContextUsage(options.contextUsage);
    setConfigurationError(options.configurationError);
  };
  const loadPermissionRequests = async (id: string): Promise<void> => {
    const requestSeq = ++permissionRequestSeqRef.current;
    try {
      const value = await requestWithRetry(ctx, 'agent', 'getPendingPermissionRequests', id);
      if (id !== conversationIdRef.current || requestSeq !== permissionRequestSeqRef.current) return;
      setPermissionRequests(Array.isArray(value) ? value as PermissionRequest[] : []);
    } catch (err) {
      if (id === conversationIdRef.current && requestSeq === permissionRequestSeqRef.current) logError('加载权限申请失败', err);
    }
  };


  useLayoutEffect(() => {
    if (!shouldFollowLatestRef.current) return;
    const list = messageListRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [conversationId, loading, messages, sending, toolEntries, localProcessEntries, permissionRequests, activity]);

  useEffect(() => {
    let disposed = false;
    const clearConversation = () => { loadSeqRef.current += 1; permissionRequestSeqRef.current += 1; shouldFollowLatestRef.current = true; conversationIdRef.current = null; stopRequestedRef.current = false; setConversationId(null); setDraft(false); setProject(null); setMessages([]); setLoading(false); setSending(false); setStopping(false); setActivity(null); setContextUsage(null); setError(null); setConfigurationError(null); setToolEntries([]); setLocalProcessEntries([]); setPermissionRequests([]); setResolvingPermissionId(null); };
    const enterDraft = (value: unknown) => {
      const draftData = value as DraftData | null;
      clearConversation(); setSource(draftData?.source || 'codex'); setProject(draftData?.project || null); setDraft(true);
    };
    const loadConversation = (id: string) => {
      const seq = ++loadSeqRef.current;
      const preserveSending = sendingRef.current && (pendingConversationIdRef.current === id || conversationIdRef.current === id);
      shouldFollowLatestRef.current = true;
      conversationIdRef.current = id;
      setConversationId(id); setSource(sourceFromId(id)); setDraft(false); setProject(null); setLoading(true); setContextUsage(null); setPermissionRequests([]); setResolvingPermissionId(null); if (!preserveSending) { setSending(false); setStopping(false); setActivity(null); } setError(null); setConfigurationError(null); if (!preserveSending) { setMessages([]); setToolEntries([]); setLocalProcessEntries([]); }
      requestWithRetry(ctx, 'agent', 'getMessages', id).then((data: unknown) => { if (!disposed && seq === loadSeqRef.current) { const loaded = Array.isArray(data) ? data as MessageData[] : []; setMessages((current) => { if (!preserveSending || !sendingRef.current) return loaded; const loadedIds = new Set(loaded.map((message) => message.id)); return [...loaded, ...current.filter((message) => message.id.startsWith('opt-') && !loadedIds.has(message.id))]; }); setLoading(false); } }).catch((err: unknown) => { if (!disposed && seq === loadSeqRef.current) { logError('加载消息失败', err); setError(`消息加载失败：${readableErrorMessage(err)}`); setLoading(false); } });
      loadTrace(id, seq);
      loadPermissionRequests(id);
      requestWithRetry(ctx, 'agent', 'getConversationOptions', id).then((options: unknown) => {
        if (disposed || seq !== loadSeqRef.current) return;
        applyAgentOptions(options);
      }).catch((err: unknown) => { if (!disposed && seq === loadSeqRef.current) { logError('加载模型失败', err); setModels([]); setModel(''); setReasoningEffort(''); setServiceTier(''); setConfigurationError(`无法读取 Agent 配置：${readableErrorMessage(err)}`); } });
    };
    const applyConversationUiState = (value: unknown, sequence = ++uiStateSequenceRef.current) => {
      if (disposed) return;
      const state = value as ConversationUiState | null;
      const generation = typeof state?.generation === 'string' && state.generation ? state.generation : null;
      const revision = typeof state?.revision === 'number' ? state.revision : null;
      if (!acceptConversationUiState(uiStateGateRef.current, { sequence, generation, revision })) return;
      if (state?.selectedConversationId) {
        loadConversation(String(state.selectedConversationId));
      } else if (state?.draft) {
        enterDraft(state.draft);
      } else {
        clearConversation();
      }
    };
    applyUiStateRef.current = applyConversationUiState;
    registerSetter('conversation.ui.changed', (value: unknown) => applyConversationUiState(value, ++uiStateSequenceRef.current));
    registerSetter('conversation.changed', (value: unknown) => { if (!disposed && conversationIdRef.current && Array.isArray(value) && !(value as ConversationData[]).some((conversation) => conversation.id === conversationIdRef.current)) clearConversation(); });
    registerSetter('message.delta', (value: unknown) => {
      const delta = value as { conversationId?: string; messageId?: string; content?: string } | null;
      if (!disposed && delta?.conversationId === conversationIdRef.current && delta.messageId) {
        setMessages((current) => {
          const found = current.some((message) => message.id === delta.messageId);
          return found
            ? current.map((message) => message.id === delta.messageId ? { ...message, content: delta.content || '' } : message)
            : [...current, { id: delta.messageId!, role: 'assistant', content: delta.content || '' }];
        });
      }
    });
    registerSetter('message.status', (value: unknown) => {
      const payload = value as { conversationId?: string; status?: string | ProgressStatus } | null;
      const statusConversationId = payload?.conversationId;
      if (disposed || !statusConversationId || statusConversationId !== conversationIdRef.current) return;
      const progress = payload.status;
      if (typeof progress === 'string') {
        if (progress) setActivity(progress);
        return;
      }
      if (!progress || typeof progress !== 'object') return;
      if (progress.contextUsage !== undefined) setContextUsage(readContextUsage(progress.contextUsage));
      if (progress.phase === 'waiting_permission') {
        setActivity(progress.message || '等待权限确认…');
        void loadPermissionRequests(statusConversationId);
      } else if (progress.message) {
        setActivity(progress.message);
      }
      if (progress.phase === 'completed' || progress.phase === 'error') void loadPermissionRequests(statusConversationId);
    });
    const initialUiStateSequence = uiStateSequenceRef.current;
    requestWithRetry(ctx, 'conversation-list', 'getConversationUiState').then((value: unknown) => applyConversationUiState(value, initialUiStateSequence)).catch((err: unknown) => {
      if (!disposed) logError('加载对话界面状态失败', err);
    });
    return () => { disposed = true; };
  }, [ctx, registerSetter]);

  useEffect(() => {
    if (!draft) return;
    let disposed = false;
    requestWithRetry(ctx, 'agent', 'getDraftOptions', source).then((options: unknown) => {
      if (disposed) return;
      applyAgentOptions(options);
    }).catch((err: unknown) => { if (!disposed) { logError('加载草稿模型失败', err); setModels([]); setModel(''); setReasoningEffort(''); setServiceTier(''); setConfigurationError(`无法读取 Agent 配置：${readableErrorMessage(err)}`); } });
    return () => { disposed = true; };
  }, [ctx, draft, source]);

  const send = async () => {
    if (!text.trim() || sending || sendingRef.current || loading || configurationError || permissionRequests.length > 0) return;
    let target = conversationId;
    const selectedTurnOptions = turnOptionsFor(model, reasoningEffort, serviceTier);
    const processId = `send-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const processTurn = messages.filter((message) => message.role === 'user').length + 1;
    const processEntry: ToolProcessEntry = {
      id: processId,
      turn: processTurn,
      step: 0,
      callId: processId,
      name: '请求模型',
      arguments: JSON.stringify({ source, ...selectedTurnOptions, ...(selectedTurnOptions.model ? {} : { model: fallbackModel(source) }) }),
      isError: false,
    };
    setLocalProcessEntries((current) => [...current, processEntry]);
    shouldFollowLatestRef.current = true;
    sendingRef.current = true;
    stopRequestedRef.current = false;
    setSending(true); setActivity('正在准备对话…'); setError(null);
    let stopPolling = false;
    let pollPromise: Promise<void> | null = null;
    try {
      if (!target) {
        const created = await ctx.message.request('agent', 'createConversation', source, project || undefined, selectedTurnOptions) as { id: string };
        target = created.id;
        pendingConversationIdRef.current = target;
        const selectionSequence = ++uiStateSequenceRef.current;
        const snapshot = await requestWithRetry(ctx, 'conversation-list', 'selectConversation', target);
        applyUiStateRef.current(snapshot, selectionSequence);
      }
      const optimistic: MessageData = { id: `opt-${Date.now()}`, role: 'user', content: text };
      setMessages((current) => [...current, optimistic]); setText('');
      const pollTrace = async () => {
        while (!stopPolling) {
          if (target && target === conversationIdRef.current) {
            await loadTrace(target, loadSeqRef.current);
          }
          await wait(1500);
        }
      };
      pollPromise = pollTrace();
      await ctx.message.request('agent', 'sendMessage', target, optimistic.content, selectedTurnOptions);
      setLocalProcessEntries((current) => current.map((entry) => entry.id === processId ? { ...entry, result: '模型已完成', isError: false } : entry));
      stopPolling = true;
      await pollPromise;
      if (target === conversationIdRef.current) await loadTrace(target, loadSeqRef.current);
      const latest = await ctx.message.request('agent', 'getMessages', target);
      if (target === conversationIdRef.current) setMessages(Array.isArray(latest) ? latest as MessageData[] : []);
    } catch (err) {
      logError('发送消息失败', err);
      const result = stopRequestedRef.current ? '已停止当前对话' : sendErrorMessage(err);
      setLocalProcessEntries((current) => current.map((entry) => entry.id === processId ? { ...entry, result, isError: true } : entry));
    } finally {
      stopPolling = true;
      if (pollPromise) await pollPromise.catch(() => undefined);
      sendingRef.current = false;
      stopRequestedRef.current = false;
      if (pendingConversationIdRef.current === target) pendingConversationIdRef.current = null;
      setSending(false); setStopping(false); setActivity(null);
    }
  };

  const stopConversation = async (): Promise<void> => {
    const id = conversationIdRef.current;
    if (!id || !sending || stopping) return;
    stopRequestedRef.current = true;
    setStopping(true);
    setError(null);
    try {
      const stopped = await requestWithRetry(ctx, 'agent', 'stopConversation', id);
      if (stopped !== true) throw new Error('当前会话没有可终止的执行，或当前 Agent 暂不支持终止');
      setActivity('正在终止当前对话…');
    } catch (err) {
      stopRequestedRef.current = false;
      setStopping(false);
      logError('终止对话失败', err);
      setError(`终止对话失败：${readableErrorMessage(err)}`);
    }
  };

  const resolvePermission = async (requestId: string, outcome: PermissionOutcome): Promise<void> => {
    if (resolvingPermissionId) return;
    const id = conversationIdRef.current;
    if (!id) return;
    setResolvingPermissionId(requestId);
    setError(null);
    try {
      const result = await requestWithRetry(ctx, 'agent', 'resolvePermissionRequest', { requestId, outcome });
      if (result === false) throw new Error('权限申请已失效或已被处理');
      await loadPermissionRequests(id);
    } catch (err) {
      logError('处理权限申请失败', err);
      setError(`处理权限申请失败：${readableErrorMessage(err)}`);
    } finally {
      setResolvingPermissionId(null);
    }
  };

  const switchSource = async (nextSource: Source) => {
    if (!draft || nextSource === source || sending) return;
    setError(null);
    const commandSequence = ++uiStateSequenceRef.current;
    try {
      const snapshot = await requestWithRetry(ctx, 'conversation-list', 'startDraftConversation', nextSource, project || undefined);
      applyUiStateRef.current(snapshot, commandSequence);
    } catch (err) {
      logError('切换 Agent 失败', err);
      setError(`切换 Agent 失败：${readableErrorMessage(err)}`);
    }
  };


  const processEntries = [...toolEntries, ...localProcessEntries];
  const toolEntriesByTurn = groupEntriesByTurn(processEntries);
  const selectedModelOption = models.find((item) => item.id === model);
  const reasoningOptions = selectedModelOption?.reasoningEfforts?.length ? selectedModelOption.reasoningEfforts : (reasoningEffort ? [{ id: reasoningEffort, name: reasoningEffort }] : []);
  const serviceTierOptions = selectedModelOption?.serviceTiers?.length ? selectedModelOption.serviceTiers : (serviceTier ? [{ id: serviceTier, name: serviceTier }] : []);
  const selectModel = (nextModel: string): void => {
    const next = models.find((item) => item.id === nextModel);
    setModel(nextModel);
    setReasoningEffort(optionValue(next?.reasoningEfforts, undefined, next?.defaultReasoningEffort));
    setServiceTier(optionValue(next?.serviceTiers, undefined, next?.defaultServiceTier));
  };
  const messageTurnMap = new Map<string, number>();
  const renderedProcessIds = new Set<string>();
  {
    let userIndex = 0;
    for (const msg of messages) {
      if (msg.role === 'user') {
        userIndex += 1;
        messageTurnMap.set(msg.id, userIndex);
      }
    }
  }

  const composer = <div className="composer-shell">
    <textarea value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } }} placeholder="随心输入，Shift + Enter 换行" rows={draft || messages.length === 0 ? 5 : 3} disabled={loading || sending || permissionRequests.length > 0} />
    <div className="composer-toolbar">
      <button type="button" className="composer-add" aria-label="添加上下文" title="添加上下文">＋</button>
      <div className="source-tabs" role="tablist" aria-label="选择 Agent">{(['codex', 'harbors'] as const).map((item) => <button key={item} type="button" role="tab" aria-selected={source === item} className={source === item ? 'selected' : ''} disabled={!draft && source !== item} onClick={() => void switchSource(item)}>{item === 'codex' ? '⌘ Codex' : '⚓ HubBert'}</button>)}</div>
      <label className="option-picker model-picker">模型<select value={model} disabled={models.length < 2} onChange={(event) => selectModel(event.target.value)}>{models.length ? models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>) : <option value="">{fallbackModel(source)}</option>}</select></label>
      {reasoningOptions.length > 0 && <label className="option-picker reasoning-picker">推理深度<select value={reasoningEffort} disabled={reasoningOptions.length < 2} onChange={(event) => setReasoningEffort(event.target.value)}>{reasoningOptions.map((item) => <option key={item.id} value={item.id} title={item.description}>{item.name}</option>)}</select></label>}
      {serviceTierOptions.length > 0 && <label className="option-picker service-tier-picker">服务档位<select value={serviceTier} disabled={serviceTierOptions.length < 2} onChange={(event) => setServiceTier(event.target.value)}>{serviceTierOptions.map((item) => <option key={item.id} value={item.id} title={item.description}>{item.name}</option>)}</select></label>}
      {contextUsage && <ContextRing ratio={contextUsage.usageRatio} tokens={contextUsage.usedTokens} max={contextUsage.contextWindow} />}
      {sending && conversationId ? (
        <button type="button" className="stop-button" onClick={() => void stopConversation()} disabled={stopping} aria-label="终止当前对话">{stopping ? '终止中…' : '终止'}</button>
      ) : (
        <button type="button" className="send-button" onClick={send} disabled={!text.trim() || loading || sending || permissionRequests.length > 0 || Boolean(configurationError)} aria-label="发送消息">↑</button>
      )}
    </div>
  </div>;

  return <div className="message-panel">
    {(error || configurationError) && <div role="alert" className="error-alert">{error || configurationError}</div>}
    <div className="message-list-container" ref={messageListRef} onScroll={(event) => {
      const list = event.currentTarget;
      shouldFollowLatestRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
    }}>
      {!conversationId && !draft ? <div className="empty-state"><div className="empty-state-card"><div className="empty-state-mark">✦</div><h2>选择或新建一个对话</h2><p>从左侧项目中继续工作，或点击“新对话”开始。</p></div></div> : <div className={`chat-surface ${draft || messages.length === 0 ? 'fresh' : ''}`}>
        {(draft || messages.length === 0) && <div className="new-thread-context"><span>▣ 当前项目</span><strong>{project ? project.split('/').filter(Boolean).slice(-2).join(' / ') : '本地项目'}</strong><span>{source === 'harbors' ? '⚓ HubBert' : '⌘ Codex'} · {models.find((item) => item.id === model)?.name || fallbackModel(source)}</span></div>}
        {messages.map((message) => {
          const turn = messageTurnMap.get(message.id);
          const turnEntries = turn !== undefined ? (toolEntriesByTurn.get(turn) ?? []) : [];
          return (
            <Fragment key={message.id}>
              <article className={`chat-message ${message.role}`}><div className="chat-message-content"><MarkdownMessage content={message.content} /></div></article>
              {message.role === 'user' && turnEntries.map((entry) => { renderedProcessIds.add(entry.id); return <Fragment key={entry.id}><ToolProcessCard entry={entry} /></Fragment>; })}
            </Fragment>
          );
        })}
        {processEntries.filter((entry) => !renderedProcessIds.has(entry.id)).map((entry) => <Fragment key={entry.id}><ToolProcessCard entry={entry} /></Fragment>)}
        {permissionRequests.map((request) => <Fragment key={request.requestId}><PermissionRequestCard request={request} resolving={resolvingPermissionId === request.requestId} onResolve={(outcome) => void resolvePermission(request.requestId, outcome)} /></Fragment>)}
        {sending && <div className="sending-indicator">{activity || (messages.some((message) => message.role === 'assistant' && !message.content) ? '正在生成回复…' : '正在请求模型…')}</div>}
      </div>}
    </div>
    {(conversationId || draft) && <div className="message-input-container">{composer}</div>}
  </div>;
}
// test
