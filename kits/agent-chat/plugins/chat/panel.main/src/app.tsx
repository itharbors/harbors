import { createElement, useCallback, useEffect, useLayoutEffect, useRef, useState, type UIEvent } from 'react';
import { acceptConversationUiState, createConversationUiStateGate } from './ui-state-gate.js';
import { createTraceSyncRunGate, createTraceSyncState, mergeTraceEvents, mergeTracePage, readTraceEvent, scheduleTraceSyncRun, traceSyncFailureMessage, type TraceSyncState } from './trace-sync.js';
import { parseTraceTurns, parseSurfaceMessages, type ToolProcessEntry, type TraceEvent, type TraceTurn } from './trace-events.js';
import Transcript, { nextDisplayTurn } from './transcript.js';
import { captureLinkClick, createLinkClickedPayload, createLinkClickSequenceGate } from './link-click.js';
import { applyMessageDeltaUpdates, createMessageDeltaScheduler, shouldIgnorePendingBottomScroll, type MessageDeltaUpdate } from './update-scheduler.js';
import { readModelCatalogPayload, selectModelForCatalog, type ModelCatalogOption } from './model-catalog.js';
import './index.css';

type Source = 'harbors';
interface MessageData { id: string; role: 'user' | 'assistant'; content: string; turn?: number; }
interface ConversationData { id: string; active?: boolean; }
interface DraftData { source?: Source; project?: string; }
interface ConversationUiState { selectedConversationId?: string | null; selectedProject?: string | null; draft?: DraftData | null; running?: boolean; generation?: string; revision?: number; }
interface SelectOption { id: string; name: string; description?: string; }
interface ModelOption extends ModelCatalogOption { reasoningEfforts?: SelectOption[]; serviceTiers?: SelectOption[]; defaultReasoningEffort?: string; defaultServiceTier?: string; }
type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
type ApprovalPolicy = 'ask' | 'always';
interface PermissionOptions { sandboxModes: SandboxMode[]; approvalPolicies: ApprovalPolicy[]; defaultSandboxMode: SandboxMode; defaultApprovalPolicy: ApprovalPolicy; }
interface TurnOptions { model?: string; reasoningEffort?: string; serviceTier?: string; sandboxMode?: SandboxMode; approvalPolicy?: ApprovalPolicy; }
interface ContextUsage { model?: string; contextWindow: number; usedTokens: number; usageRatio: number; estimated?: boolean; }
interface AgentOptionsResponse { models?: ModelOption[]; defaultModel?: string; defaultReasoningEffort?: string; defaultServiceTier?: string; selectedModel?: string; selectedReasoningEffort?: string; selectedServiceTier?: string; selectedSandboxMode?: SandboxMode; selectedApprovalPolicy?: ApprovalPolicy; selection?: TurnOptions; permissions?: PermissionOptions; contextUsage?: ContextUsage; configurationError?: string; }
type PermissionOutcome = 'allowed-once' | 'rejected';
interface PermissionRequest { requestId: string; conversationId: string; turnId?: string; itemId?: string; turn: number; step: number; toolName: string; currentMode: string; requestedMode?: string; justification?: string; }
interface ProgressStatus { phase?: string; message?: string; turn?: number; step?: number; contextUsage?: ContextUsage; }
interface TraceAppendPayload { conversationId?: unknown; event?: unknown; cursor?: unknown; }
interface TraceBatch { conversationId?: string; afterSeq?: number; cursor?: number; events?: unknown[]; }
interface TracePageResponse { conversationId?: string; cursor?: number; events?: unknown[]; hasMore?: boolean; oldestSeq?: number; nextBeforeSeq?: number | null; }
const REQUEST_RETRY_DELAYS = [0, 100, 250, 500, 1000];
const TRACE_TURN_PAGE_SIZE = 6;

function readTraceEventList(value: unknown): { events: TraceEvent[]; invalid: boolean } {
  const raw = Array.isArray(value) ? value : [];
  const events = raw.map(readTraceEvent).filter((event): event is TraceEvent => event !== null);
  return { events, invalid: events.length !== raw.length };
}

function sourceFromId(_id: string): Source { return 'harbors'; }
function fallbackModel(_source: Source): string { return 'HubBert Relay'; }
function normalizeApprovalPolicy(value: unknown): ApprovalPolicy | undefined {
  if (value === 'ask' || value === 'always') return value;
  // Agent 将旧会话中的 never 迁移为 always；面板也保留这一层兼容，避免旧快照让选择框失去选中值。
  if (value === 'never') return 'always';
  return undefined;
}
function approvalPolicyLabel(value: ApprovalPolicy): string {
  return value === 'ask' ? '每次询问' : '始终';
}
function turnOptionsFor(model: string, reasoningEffort: string, serviceTier: string, sandboxMode: SandboxMode | '', approvalPolicy: ApprovalPolicy | ''): TurnOptions {
  return { ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}), ...(serviceTier ? { serviceTier } : {}), ...(sandboxMode ? { sandboxMode } : {}), ...(approvalPolicy ? { approvalPolicy } : {}) };
}
function optionValue(options: SelectOption[] | undefined, selected: string | undefined, fallback: string | undefined): string {
  return selected || fallback || options?.[0]?.id || '';
}
function readAgentOptions(value: unknown): { models: ModelOption[]; selection: TurnOptions; permissions: PermissionOptions | null; contextUsage: ContextUsage | null; configurationError: string | null } {
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
      sandboxMode: typed?.selection?.sandboxMode || typed?.selectedSandboxMode || typed?.permissions?.defaultSandboxMode,
      approvalPolicy: normalizeApprovalPolicy(typed?.selection?.approvalPolicy || typed?.selectedApprovalPolicy || typed?.permissions?.defaultApprovalPolicy),
    },
    permissions: typed?.permissions || null,
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

interface DirEntry { name: string; path: string; }
interface DirListing { path: string; parent: string | null; home: string; directories: DirEntry[]; }

function DirectoryPicker({ ctx, initialPath, onCancel, onConfirm }: { ctx: any; initialPath: string | null; onCancel: () => void; onConfirm: (path: string) => void; }) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [manualPath, setManualPath] = useState('');

  const browse = useCallback(async (dir?: string) => {
    setLoading(true); setError(null);
    try {
      const result = await ctx.message.request('agent', 'listDirectory', dir) as DirListing;
      setListing(result);
      setManualPath(result.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [ctx]);

  useEffect(() => { void browse(initialPath || undefined); }, [browse, initialPath]);

  return (
    <div className="dir-picker-overlay" onClick={onCancel}>
      <div className="dir-picker" onClick={(event) => event.stopPropagation()}>
        <div className="dir-picker-header">
          <span>选择项目目录</span>
          <button type="button" className="dir-picker-close" onClick={onCancel} aria-label="关闭">×</button>
        </div>
        <div className="dir-picker-path">
          <input
            type="text"
            value={manualPath}
            spellCheck={false}
            onChange={(event) => setManualPath(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void browse(manualPath.trim() || undefined); }}
            placeholder="输入目录路径后回车"
          />
          <button type="button" onClick={() => void browse(manualPath.trim() || undefined)}>前往</button>
        </div>
        {error && <div className="dir-picker-error">{error}</div>}
        <div className="dir-picker-list">
          {listing?.parent && (
            <button type="button" className="dir-picker-item up" onClick={() => void browse(listing.parent || undefined)}>
              <span className="dir-picker-icon">↰</span> 上级目录
            </button>
          )}
          {loading && <div className="dir-picker-loading">加载中…</div>}
          {!loading && listing && listing.directories.length === 0 && <div className="dir-picker-empty">该目录下没有子目录</div>}
          {!loading && listing?.directories.map((entry) => (
            <button key={entry.path} type="button" className="dir-picker-item" onClick={() => void browse(entry.path)}>
              <span className="dir-picker-icon">▸</span> {entry.name}
            </button>
          ))}
        </div>
        <div className="dir-picker-actions">
          <button type="button" onClick={onCancel}>取消</button>
          <button type="button" className="primary" disabled={!listing} onClick={() => listing && onConfirm(listing.path)}>选择当前目录</button>
        </div>
      </div>
    </div>
  );
}

interface OptionItem { value: string; label: string; title?: string; }

function OptionPicker({ label, icon, value, options, disabled, compact, className, onChange }: {
  label: string;
  icon: string;
  value: string;
  options: OptionItem[];
  disabled?: boolean;
  compact: boolean;
  className?: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ left: number; bottom: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const current = options.find((item) => item.value === value);

  const toggle = () => {
    if (disabled) return;
    if (open) { setOpen(false); return; }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setCoords({ left: rect.left, bottom: window.innerHeight - rect.top + 6 });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: globalThis.MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    const onScrollOrResize = () => setOpen(false);
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [open]);

  if (!compact) {
    return (
      <label className={`option-picker ${className || ''}`}>{label}
        <select value={value} disabled={disabled || options.length < 2} onChange={(event) => onChange(event.target.value)}>
          {options.length ? options.map((item) => <option key={item.value} value={item.value} title={item.title}>{item.label}</option>) : <option value="">{label}</option>}
        </select>
      </label>
    );
  }

  return (
    <div className={`option-picker compact ${className || ''}`} ref={rootRef}>
      <button
        type="button"
        ref={buttonRef}
        className={`option-icon-button ${open ? 'open' : ''}`}
        disabled={disabled}
        title={`${label}：${current?.label ?? ''}`}
        aria-label={`${label}：${current?.label ?? ''}`}
        onClick={toggle}
      >
        <span className="option-icon">{icon}</span>
      </button>
      {open && coords && (
        <div className="option-popover" role="listbox" style={{ left: coords.left, bottom: coords.bottom }}>
          <div className="option-popover-title">{label}</div>
          {options.map((item) => (
            <button
              key={item.value}
              type="button"
              className={`option-popover-item ${item.value === value ? 'selected' : ''}`}
              title={item.title}
              onClick={() => { onChange(item.value); setOpen(false); }}
            >
              <span className="option-popover-check">{item.value === value ? '✓' : ''}</span>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App({ ctx, registerSetter }: { ctx: any; registerSetter: (key: string, setter: (data: any) => void) => void; }) {
  const [messages, setMessages] = useState<MessageData[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [source, setSource] = useState<Source>('harbors');
  const [draft, setDraft] = useState(false);
  const [project, setProject] = useState<string | null>(null);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [toolbarCompact, setToolbarCompact] = useState(false);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('');
  const [serviceTier, setServiceTier] = useState('');
  const [permissionOptions, setPermissionOptions] = useState<PermissionOptions | null>(null);
  const [sandboxMode, setSandboxMode] = useState<SandboxMode | ''>('');
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy | ''>('');
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [configurationError, setConfigurationError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [pendingMessages, setPendingMessages] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [traceTurns, setTraceTurns] = useState<TraceTurn[]>([]);
  const [localProcessEntries, setLocalProcessEntries] = useState<ToolProcessEntry[]>([]);
  const [permissionRequests, setPermissionRequests] = useState<PermissionRequest[]>([]);
  const [resolvingPermissionId, setResolvingPermissionId] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [traceHasMore, setTraceHasMore] = useState(false);
  const [traceOlderLoading, setTraceOlderLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const projectRef = useRef<string | null>(null);
  const linkClickSequenceRef = useRef(createLinkClickSequenceGate());
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
  const traceStateRef = useRef<TraceSyncState>(createTraceSyncState());
  const traceSyncRunGateRef = useRef(createTraceSyncRunGate());
  const traceSyncErrorRef = useRef<string | null>(null);
  const tracePageRequestSeqRef = useRef(0);
  const traceOlderLoadingRef = useRef(false);
  const olderScrollAnchorRef = useRef<{ top: number; height: number } | null>(null);
  const messageDeltaSchedulerRef = useRef<ReturnType<typeof createMessageDeltaScheduler> | null>(null);
  const bottomScrollFrameRef = useRef<number | null>(null);
  const bottomScrollGenerationRef = useRef(0);
  const permissionRequestSeqRef = useRef(0);
  const activeConversationsRef = useRef<Set<string>>(new Set());
  const conversationsMapRef = useRef<Map<string, ConversationData>>(new Map());
  const sendingConversationRef = useRef<string | null>(null);

  const resetTraceState = (id: string | null): void => {
    traceRequestSeqRef.current += 1;
    tracePageRequestSeqRef.current += 1;
    traceOlderLoadingRef.current = false;
    setTraceOlderLoading(false);
    setTraceHasMore(false);
    traceStateRef.current = createTraceSyncState(id);
  };

  const cancelBottomScroll = (): void => {
    bottomScrollGenerationRef.current += 1;
    if (bottomScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(bottomScrollFrameRef.current);
      bottomScrollFrameRef.current = null;
    }
  };

  const publishTraceState = (id: string, state: TraceSyncState): void => {
    if (conversationIdRef.current !== id) return;
    setTraceTurns(parseTraceTurns(state.events));
    const derived = parseSurfaceMessages(state.events) as MessageData[];
    setMessages((current) => {
      const confirmed = new Set(derived.map((message) => `${message.role}\u0000${message.content}`));
      // 保留仍在流式输出、轨迹尚未落盘的临时消息：给该会话发送时的乐观 user 消息（opt-）、以及 delta 推送的 assistant 消息（msg-）。
      const keepOptimistic = sendingRef.current && sendingConversationRef.current === id
        ? current.filter((message) => message.id.startsWith('opt-') && !confirmed.has(`${message.role}\u0000${message.content}`))
        : [];
      const keepStreaming = sendingRef.current && sendingConversationRef.current === id
        ? current.filter((message) => message.id.startsWith('msg-') && message.role === 'assistant' && message.content && !confirmed.has(`${message.role}\u0000${message.content}`))
        : [];
      return [...derived, ...keepOptimistic, ...keepStreaming];
    });
  };

  const applyTraceEvents = (id: string, events: TraceEvent[]) => {
    if (conversationIdRef.current !== id) return null;
    const current = traceStateRef.current.conversationId === id ? traceStateRef.current : createTraceSyncState(id);
    const merged = mergeTraceEvents(current, events);
    traceStateRef.current = merged;
    setTraceHasMore(merged.hasMore);
    publishTraceState(id, merged);
    return merged;
  };

  const loadTrace = async (id: string, seq: number): Promise<void> => {
    const requestSeq = ++traceRequestSeqRef.current;
    let recoveryStarted = false;
    try {
      const page = await requestWithRetry(ctx, 'agent', 'getConversationTracePage', id, { turnLimit: TRACE_TURN_PAGE_SIZE }) as TracePageResponse;
      if (seq !== loadSeqRef.current || requestSeq !== traceRequestSeqRef.current || conversationIdRef.current !== id) return;
      if (page?.conversationId && page.conversationId !== id) throw new Error('轨迹快照会话不匹配');
      const parsed = readTraceEventList(page?.events);
      const list = parsed.events;
      if (parsed.invalid) {
        logError('轨迹快照包含非法事件，开始完整恢复', { conversationId: id });
        recoveryStarted = true;
        await recoverTraceSnapshot(id, seq, requestSeq);
        return;
      }
      const current = traceStateRef.current.conversationId === id ? traceStateRef.current : createTraceSyncState(id);
      const merged = mergeTracePage(current, {
        cursor: Number.isSafeInteger(page?.cursor) ? page.cursor! : current.cursor,
        events: list,
        hasMore: page?.hasMore === true,
        oldestSeq: Number.isSafeInteger(page?.oldestSeq) ? page.oldestSeq! : (list[0]?.seq ?? -1),
        nextBeforeSeq: page?.nextBeforeSeq ?? null,
      });
      if (merged.hasConflict || merged.hasGap) {
        logError('轨迹快照包含冲突 seq 或页内缺口，开始完整恢复', { conversationId: id });
        recoveryStarted = true;
        await recoverTraceSnapshot(id, seq, requestSeq);
        return;
      }
      traceStateRef.current = merged;
      setTraceHasMore(merged.hasMore);
      publishTraceState(id, merged);
      if (Number.isSafeInteger(page?.cursor) && page.cursor! > merged.cursor) void syncTraceSince(id);
    } catch (err) {
      if (seq === loadSeqRef.current && requestSeq === traceRequestSeqRef.current) {
        if (!recoveryStarted) {
          try {
            await recoverTraceSnapshot(id, seq, requestSeq);
            return;
          } catch (recoveryError) {
            logError('加载轨迹及完整恢复失败', recoveryError);
            setError(`加载对话记录失败：${readableErrorMessage(recoveryError)}`);
            return;
          }
        }
        logError('完整恢复轨迹失败', err);
        setError(`加载对话记录失败：${readableErrorMessage(err)}`);
      }
    }
  };

  async function recoverTraceSnapshot(id: string, seq: number, requestSeq: number): Promise<void> {
    const batch = await requestWithRetry(ctx, 'agent', 'getConversationTraceSince', id, -1) as TraceBatch;
    if (seq !== loadSeqRef.current || requestSeq !== traceRequestSeqRef.current || conversationIdRef.current !== id) return;
    if (batch?.conversationId && batch.conversationId !== id) throw new Error('完整轨迹恢复会话不匹配');
    const parsed = readTraceEventList(batch?.events);
    if (parsed.invalid) throw new Error('完整轨迹恢复包含非法事件');
    const events = parsed.events;
    const cursor = Number.isSafeInteger(batch?.cursor) ? batch.cursor! : (events.at(-1)?.seq ?? -1);
    // 恢复请求期间到达的更新仍需保留；cursor 以内由完整快照重新建立权威状态。
    const concurrent = traceStateRef.current.conversationId === id
      ? traceStateRef.current.events.filter((event) => event.seq > cursor)
      : [];
    const buffered = mergeTraceEvents(createTraceSyncState(id), concurrent);
    const recovered = mergeTracePage(buffered, {
      cursor,
      events,
      hasMore: false,
      oldestSeq: events[0]?.seq ?? -1,
      nextBeforeSeq: null,
    });
    if (recovered.hasConflict || recovered.hasGap) throw new Error('完整轨迹恢复后仍存在重复 seq 或缺口');
    traceStateRef.current = recovered;
    setTraceHasMore(false);
    publishTraceState(id, recovered);
  }

  const loadOlderTrace = async (id: string): Promise<void> => {
    if (conversationIdRef.current !== id || traceOlderLoadingRef.current) return;
    const state = traceStateRef.current;
    if (state.conversationId !== id || !state.hasMore || state.nextBeforeSeq === null) return;
    const requestSeq = ++tracePageRequestSeqRef.current;
    const list = messageListRef.current;
    if (list) olderScrollAnchorRef.current = { top: list.scrollTop, height: list.scrollHeight };
    traceOlderLoadingRef.current = true;
    setTraceOlderLoading(true);
    try {
      const page = await requestWithRetry(ctx, 'agent', 'getConversationTracePage', id, { beforeSeq: state.nextBeforeSeq, turnLimit: TRACE_TURN_PAGE_SIZE }) as TracePageResponse;
      if (conversationIdRef.current !== id || requestSeq !== tracePageRequestSeqRef.current) return;
      if (page?.conversationId && page.conversationId !== id) throw new Error('历史轨迹页会话不匹配');
      const parsed = readTraceEventList(page?.events);
      if (parsed.invalid) throw new Error('历史轨迹页包含非法事件');
      const events = parsed.events;
      const current = traceStateRef.current;
      const merged = mergeTracePage(current, {
        cursor: Number.isSafeInteger(page?.cursor) ? page.cursor! : current.cursor,
        events,
        hasMore: page?.hasMore === true,
        oldestSeq: Number.isSafeInteger(page?.oldestSeq) ? page.oldestSeq! : (events[0]?.seq ?? -1),
        nextBeforeSeq: page?.nextBeforeSeq ?? null,
      });
      if (merged.hasConflict || merged.hasGap) {
        const recoveryRequestSeq = ++traceRequestSeqRef.current;
        await recoverTraceSnapshot(id, loadSeqRef.current, recoveryRequestSeq);
        return;
      }
      traceStateRef.current = merged;
      setTraceHasMore(merged.hasMore);
      publishTraceState(id, merged);
      if (Number.isSafeInteger(page?.cursor) && page.cursor! > merged.cursor) void syncTraceSince(id);
    } catch (err) {
      if (conversationIdRef.current === id && requestSeq === tracePageRequestSeqRef.current) {
        logError('加载更早轨迹失败', err);
        setError(`加载更早对话记录失败：${readableErrorMessage(err)}`);
      }
    } finally {
      if (requestSeq === tracePageRequestSeqRef.current) {
        traceOlderLoadingRef.current = false;
        setTraceOlderLoading(false);
      }
    }
  };

  async function syncTraceSince(id: string): Promise<void> {
    if (conversationIdRef.current !== id) return;
    return scheduleTraceSyncRun(traceSyncRunGateRef.current, id, async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3 && conversationIdRef.current === id; attempt += 1) {
        try {
          const state = traceStateRef.current.conversationId === id ? traceStateRef.current : createTraceSyncState(id);
          if (!state.initialized) return;
          const batch = await requestWithRetry(ctx, 'agent', 'getConversationTraceSince', id, state.cursor) as TraceBatch;
          if (conversationIdRef.current !== id) return;
          if (batch?.conversationId && batch.conversationId !== id) throw new Error('增量轨迹会话不匹配');
          const parsed = readTraceEventList(batch?.events);
          if (parsed.invalid) throw new Error('增量轨迹包含非法事件');
          const events = parsed.events;
          const merged = applyTraceEvents(id, events);
          const remoteCursor = Number.isSafeInteger(batch?.cursor) ? batch.cursor! : merged?.cursor;
          if (merged?.hasConflict) throw new Error('增量轨迹包含冲突 seq');
          if (merged && !merged.hasGap && (remoteCursor === undefined || remoteCursor <= merged.cursor)) return;
        } catch (err) {
          lastError = err;
        }
      }

      // 补拉接口连续异常、返回缺口或冲突时，用完整快照恢复一次，避免静默丢失过程。
      if (conversationIdRef.current === id) {
        const requestSeq = ++traceRequestSeqRef.current;
        try {
          await recoverTraceSnapshot(id, loadSeqRef.current, requestSeq);
        } catch (recoveryError) {
          throw recoveryError || lastError;
        }
      }
    }, () => {
      const state = traceStateRef.current;
      return conversationIdRef.current === id && state.conversationId === id && (state.hasConflict || ('hasGap' in state && state.hasGap === true));
    }, () => {
      if (conversationIdRef.current !== id || !traceSyncErrorRef.current) return;
      const previous = traceSyncErrorRef.current;
      traceSyncErrorRef.current = null;
      setError((current) => current === previous ? null : current);
    }, (err) => {
      if (conversationIdRef.current === id) {
        logError('同步增量轨迹失败', err);
        const message = traceSyncFailureMessage(err);
        traceSyncErrorRef.current = message;
        setError(message);
      }
    });
  }

  const applyTraceAppend = (value: unknown): void => {
    const payload = value as TraceAppendPayload | null;
    if (!payload?.conversationId || String(payload.conversationId) !== conversationIdRef.current) return;
    const event = readTraceEvent(payload.event);
    if (!event) {
      void syncTraceSince(String(payload.conversationId));
      return;
    }
    if (Number.isSafeInteger(payload.cursor) && Number(payload.cursor) !== event.seq) {
      void syncTraceSince(String(payload.conversationId));
      return;
    }
    const merged = applyTraceEvents(String(payload.conversationId), [event]);
    if (merged?.hasGap || merged?.hasConflict) void syncTraceSince(String(payload.conversationId));
  };
  const applyAgentOptions = (value: unknown): void => {
    const options = readAgentOptions(value);
    setModels(options.models);
    setModel(options.selection.model || '');
    setReasoningEffort(options.selection.reasoningEffort || '');
    setServiceTier(options.selection.serviceTier || '');
    setPermissionOptions(options.permissions);
    setSandboxMode(options.selection.sandboxMode || '');
    setApprovalPolicy(options.selection.approvalPolicy || '');
    setContextUsage(options.contextUsage);
    setConfigurationError(options.configurationError);
  };
  const applyModelCatalogBroadcast = (value: unknown): void => {
    const payload = readModelCatalogPayload(value);
    if (!payload) return;
    setModels(payload.catalog.models);
    setModel((current) => selectModelForCatalog(current, payload.catalog));
    setConfigurationError(payload.catalog.configurationError || null);
  };
  const loadPermissionRequests = useCallback(async (id: string): Promise<void> => {
    const requestSeq = ++permissionRequestSeqRef.current;
    try {
      const value = await requestWithRetry(ctx, 'agent', 'getPendingPermissionRequests', id);
      if (id !== conversationIdRef.current || requestSeq !== permissionRequestSeqRef.current) return;
      setPermissionRequests(Array.isArray(value) ? value as PermissionRequest[] : []);
    } catch (err) {
      if (id === conversationIdRef.current && requestSeq === permissionRequestSeqRef.current) logError('加载权限申请失败', err);
    }
  }, [ctx]);


  useLayoutEffect(() => {
    const list = messageListRef.current;
    const anchor = olderScrollAnchorRef.current;
    if (list && anchor) {
      cancelBottomScroll();
      // 请求开始时 layout effect 也会运行一次；等历史页提交并结束 loading 后再消费 anchor，避免提前清空。
      if (traceOlderLoading) return;
      list.scrollTop = anchor.top + list.scrollHeight - anchor.height;
      olderScrollAnchorRef.current = null;
      return;
    }
    if (!list || !shouldFollowLatestRef.current || bottomScrollFrameRef.current !== null) return;
    const generation = bottomScrollGenerationRef.current;
    bottomScrollFrameRef.current = window.requestAnimationFrame(() => {
      bottomScrollFrameRef.current = null;
      if (generation !== bottomScrollGenerationRef.current || olderScrollAnchorRef.current || !shouldFollowLatestRef.current) return;
      const currentList = messageListRef.current;
      if (currentList) currentList.scrollTop = currentList.scrollHeight;
    });
  }, [conversationId, loading, messages, sending, traceTurns, localProcessEntries, permissionRequests, traceHasMore, traceOlderLoading]);

  useEffect(() => {
    let disposed = false;
    const messageDeltaScheduler = createMessageDeltaScheduler((updates: MessageDeltaUpdate[]) => {
      if (disposed) return;
      setMessages((current) => applyMessageDeltaUpdates(current, updates) as MessageData[]);
    });
    messageDeltaSchedulerRef.current = messageDeltaScheduler;
    const cancelPendingMessageDeltas = (): void => { messageDeltaScheduler.cancel(); };
    const clearConversation = () => { loadSeqRef.current += 1; permissionRequestSeqRef.current += 1; cancelPendingMessageDeltas(); cancelBottomScroll(); olderScrollAnchorRef.current = null; shouldFollowLatestRef.current = true; conversationIdRef.current = null; projectRef.current = null; resetTraceState(null); traceSyncErrorRef.current = null; stopRequestedRef.current = false; setConversationId(null); setDraft(false); setProject(null); setMessages([]); setPendingMessages([]); setLoading(false); setSending(false); setStopping(false); setPermissionOptions(null); setSandboxMode(''); setApprovalPolicy(''); setContextUsage(null); setError(null); setConfigurationError(null); setTraceTurns([]); setLocalProcessEntries([]); setPermissionRequests([]); setResolvingPermissionId(null); };
    const enterDraft = (value: unknown) => {
      const draftData = value as DraftData | null;
      const nextProject = draftData?.project || null;
      clearConversation(); setSource(draftData?.source || 'harbors'); projectRef.current = nextProject; setProject(nextProject); setDraft(true);
    };
    const loadConversation = (id: string, selectedProject: string | null) => {
      // UI state 的 revision 更新不代表切换会话；同一会话只靠 append 保持增量更新。
      if (conversationIdRef.current === id) {
        projectRef.current = selectedProject;
        setProject(selectedProject);
        return;
      }
      cancelPendingMessageDeltas();
      cancelBottomScroll();
      olderScrollAnchorRef.current = null;
      const seq = ++loadSeqRef.current;
      if (traceStateRef.current.conversationId !== id) resetTraceState(id);
      // 该会话是否正在执行中：后端 active 集合 或 本地正在给它发送
      const targetActive = activeConversationsRef.current.has(id) || sendingConversationRef.current === id;
      const preserveSending = (sendingRef.current && sendingConversationRef.current === id) || targetActive;
      shouldFollowLatestRef.current = true;
      conversationIdRef.current = id;
      setConversationId(id); setSource(sourceFromId(id)); setDraft(false); projectRef.current = selectedProject; setProject(selectedProject); setLoading(true); setPermissionOptions(null); setSandboxMode(''); setApprovalPolicy(''); setContextUsage(null); setPermissionRequests([]); setResolvingPermissionId(null); setSending(targetActive); if (!targetActive) setStopping(false); setError(null); setConfigurationError(null); if (!preserveSending) { setMessages([]); setTraceTurns([]); setLocalProcessEntries([]); }
      // 首次只拉最近完整 turn；更早 turn 由顶部滚动分页补入
      void loadTrace(id, seq).finally(() => { if (!disposed && seq === loadSeqRef.current) setLoading(false); });
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
        if (state.running) activeConversationsRef.current.add(String(state.selectedConversationId));
        else activeConversationsRef.current.delete(String(state.selectedConversationId));
        loadConversation(String(state.selectedConversationId), typeof state.selectedProject === 'string' && state.selectedProject ? state.selectedProject : null);
      } else if (state?.draft) {
        enterDraft(state.draft);
      } else {
        clearConversation();
      }
    };
    applyUiStateRef.current = applyConversationUiState;
    registerSetter('conversation.selected', (value: unknown) => applyConversationUiState(value, ++uiStateSequenceRef.current));
    registerSetter('agent.conversation.trace.append', applyTraceAppend);
    registerSetter('model-service.catalog.changed', applyModelCatalogBroadcast);
    registerSetter('agent.conversation.changed', (value: unknown) => {
      if (disposed || !value || typeof value !== 'object') return;
      const payload = value as { action?: string; id?: string; conversation?: ConversationData };
      if (typeof payload.id !== 'string' || !payload.action) return;
      const { action, id } = payload;
      const map = conversationsMapRef.current;
      if (action === 'create') {
        if (payload.conversation && !map.has(id)) map.set(id, payload.conversation);
      } else if (action === 'delete') {
        map.delete(id);
      } else if (action === 'rename' || action === 'update') {
        if (payload.conversation) map.set(id, { ...map.get(id), ...payload.conversation });
      }
      // 维护「正在执行中的会话」集合，作为发送锁的真相来源
      const nextActive = new Set<string>();
      for (const [convId, conv] of map) {
        if (conv.active) nextActive.add(convId);
      }
      activeConversationsRef.current = nextActive;
      const current = conversationIdRef.current;
      // 当前会话被删除时清空
      if (current && action === 'delete' && id === current) { clearConversation(); return; }
      // 根据后端状态同步当前会话的发送锁
      if (current) {
        if (nextActive.has(current)) {
          setSending(true);
        } else if (sendingConversationRef.current !== current) {
          // 后端已结束，且本地也不是正在给该会话发送 → 解锁
          messageDeltaScheduler.flush();
          void syncTraceSince(current);
          setSending(false);
          setStopping(false);
        }
      }
    });
    registerSetter('agent.message.delta', (value: unknown) => {
      const delta = value as { conversationId?: string; messageId?: string; content?: string } | null;
      if (!disposed && delta?.conversationId === conversationIdRef.current && delta.messageId) {
        messageDeltaScheduler.enqueue({ messageId: delta.messageId, content: typeof delta.content === 'string' ? delta.content : '' });
      }
    });
    registerSetter('agent.message.status', (value: unknown) => {
      const payload = value as { conversationId?: string; status?: string | ProgressStatus } | null;
      const statusConversationId = payload?.conversationId;
      if (disposed || !statusConversationId || statusConversationId !== conversationIdRef.current) return;
      const progress = payload.status;
      if (typeof progress === 'string') return;
      if (!progress || typeof progress !== 'object') return;
      if (progress.contextUsage !== undefined) setContextUsage(readContextUsage(progress.contextUsage));
      // 面板可能在会话已经开始后才收到 conversation.changed；progress 是当前回合运行态的直接信号。
      if (progress.phase === 'running' || progress.phase === 'waiting_permission') setSending(true);
      if (progress.phase === 'completed' || progress.phase === 'error') {
        // completed/error 可能紧跟最后一个 delta 到达，先提交当前帧队列再补拉轨迹。
        messageDeltaScheduler.flush();
        void syncTraceSince(statusConversationId);
      }
      if (progress.phase === 'waiting_permission') {
        void loadPermissionRequests(statusConversationId);
      }
      if (progress.phase === 'completed' || progress.phase === 'error') void loadPermissionRequests(statusConversationId);
    });
    const initialUiStateSequence = uiStateSequenceRef.current;
    requestWithRetry(ctx, 'conversation', 'getState').then((value: unknown) => applyConversationUiState(value, initialUiStateSequence)).catch((err: unknown) => {
      if (!disposed) logError('加载对话界面状态失败', err);
    });
    return () => {
      disposed = true;
      messageDeltaScheduler.cancel();
      if (messageDeltaSchedulerRef.current === messageDeltaScheduler) messageDeltaSchedulerRef.current = null;
      cancelBottomScroll();
    };
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

  useEffect(() => {
    const node = toolbarRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    // 宽松模式下每个下拉约需 175px，加上发送按钮 / 上下文环约 130px 余量；不足则切换为图标模式
    const measure = () => {
      const count = node.querySelectorAll('.option-picker').length || 1;
      const needed = count * 175 + 130;
      setToolbarCompact(node.clientWidth < needed);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  });

  const send = async (contentOverride?: string) => {
    const content = (contentOverride ?? [...pendingMessages, text].map((item) => item.trim()).filter(Boolean).join('\n')).trim();
    const currentActive = sending || (sendingRef.current && sendingConversationRef.current === conversationId) || (!!conversationId && activeConversationsRef.current.has(conversationId));
    if (!content || currentActive || loading || configurationError || permissionRequests.length > 0) return;
    let target = conversationId;
    let traceCursorBeforeSend = traceStateRef.current.conversationId === target ? traceStateRef.current.cursor : -1;
    const selectedTurnOptions = turnOptionsFor(model, reasoningEffort, serviceTier, sandboxMode, approvalPolicy);
    const processId = `send-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const processTurn = nextDisplayTurn(messages, traceTurns);
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
    sendingConversationRef.current = target;
    stopRequestedRef.current = false;
    setSending(true); setError(null);
    try {
      if (!target) {
        const created = await ctx.message.request('agent', 'createConversation', source, project || undefined, selectedTurnOptions) as { id: string };
        target = created.id;
        sendingConversationRef.current = target;
        pendingConversationIdRef.current = target;
        const selectionSequence = ++uiStateSequenceRef.current;
        const snapshot = await requestWithRetry(ctx, 'conversation', 'select', target);
        applyUiStateRef.current(snapshot, selectionSequence);
        traceCursorBeforeSend = traceStateRef.current.conversationId === target ? traceStateRef.current.cursor : -1;
      }
      const optimistic: MessageData = { id: `opt-${Date.now()}`, role: 'user', content };
      setMessages((current) => [...current, optimistic]); setText(''); setPendingMessages([]);
      await ctx.message.request('agent', 'sendMessage', target, optimistic.content, selectedTurnOptions);
      await syncTraceSince(target);
      setLocalProcessEntries((current) => current.filter((entry) => entry.id !== processId));
    } catch (err) {
      logError('发送消息失败', err);
      if (target) await syncTraceSince(target);
      const result = stopRequestedRef.current ? '已停止当前对话' : sendErrorMessage(err);
      const traceRecordedFailure = target === traceStateRef.current.conversationId && traceStateRef.current.cursor > traceCursorBeforeSend;
      setLocalProcessEntries((current) => traceRecordedFailure
        ? current.filter((entry) => entry.id !== processId)
        : current.map((entry) => entry.id === processId ? { ...entry, result, isError: true } : entry));
    } finally {
      sendingRef.current = false;
      if (sendingConversationRef.current === target) sendingConversationRef.current = null;
      stopRequestedRef.current = false;
      if (pendingConversationIdRef.current === target) pendingConversationIdRef.current = null;
      if (target && conversationIdRef.current === target && traceStateRef.current.conversationId === target) publishTraceState(target, traceStateRef.current);
      // 只有当前显示的仍是本次发送的会话时，才在此处解锁，避免误伤已切走的其他会话
      if (conversationIdRef.current === target) { setSending(false); setStopping(false); }
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
    } catch (err) {
      stopRequestedRef.current = false;
      setStopping(false);
      logError('终止对话失败', err);
      setError(`终止对话失败：${readableErrorMessage(err)}`);
    }
  };

  const resolvePermission = useCallback(async (requestId: string, outcome: PermissionOutcome): Promise<void> => {
    if (resolvingPermissionId) return;
    const id = conversationIdRef.current;
    if (!id) return;
    setResolvingPermissionId(requestId);
    setError(null);
    try {
      const request = permissionRequests.find((candidate) => candidate.requestId === requestId);
      const result = await requestWithRetry(ctx, 'agent', 'resolvePermissionRequest', { requestId, outcome, conversationId: id, ...(request?.turnId ? { turnId: request.turnId } : {}), ...(request?.itemId ? { itemId: request.itemId } : {}) });
      if (result === false) throw new Error('权限申请已失效或已被处理');
      await loadPermissionRequests(id);
    } catch (err) {
      logError('处理权限申请失败', err);
      setError(`处理权限申请失败：${readableErrorMessage(err)}`);
    } finally {
      setResolvingPermissionId(null);
    }
  }, [ctx, loadPermissionRequests, permissionRequests, resolvingPermissionId]);

  const updateConversationPermissions = async (nextSandboxMode: SandboxMode | '', nextApprovalPolicy: ApprovalPolicy | ''): Promise<void> => {
    if (sending) return;
    const id = conversationIdRef.current;
    if (!draft && !id) return;
    setSandboxMode(nextSandboxMode);
    setApprovalPolicy(nextApprovalPolicy);
    if (draft || !id) return;
    setError(null);
    try {
      const result = await requestWithRetry(ctx, 'agent', 'setConversationPermissions', id, {
        ...(nextSandboxMode ? { sandboxMode: nextSandboxMode } : {}),
        ...(nextApprovalPolicy ? { approvalPolicy: nextApprovalPolicy } : {}),
      }) as { sandboxMode?: SandboxMode; approvalPolicy?: ApprovalPolicy };
      if (id !== conversationIdRef.current) return;
      if (result?.sandboxMode) setSandboxMode(result.sandboxMode);
      if (result?.approvalPolicy) setApprovalPolicy(result.approvalPolicy);
    } catch (err) {
      logError('更新权限设置失败', err);
      setError(`更新权限设置失败：${readableErrorMessage(err)}`);
    }
  };

  const switchSource = async (nextSource: Source) => {
    if (!draft || nextSource === source || sending) return;
    setError(null);
    const commandSequence = ++uiStateSequenceRef.current;
    try {
      const snapshot = await requestWithRetry(ctx, 'conversation', 'select', null, project ? { project } : undefined);
      applyUiStateRef.current(snapshot, commandSequence);
    } catch (err) {
      logError('切换 Agent 失败', err);
      setError(`切换 Agent 失败：${readableErrorMessage(err)}`);
    }
  };

  const handleLinkClick = useCallback((info: { href: string; text: string }) => {
    // Capture the render state synchronously: a fast conversation/project switch
    // must not change the context attached to this click while the request runs.
    const snapshot = captureLinkClick(info, conversationIdRef.current, projectRef.current);
    const clickSequence = linkClickSequenceRef.current.next();
    void ctx.message.request('chat', 'normalizeLink', snapshot.href, snapshot.selectedProject)
      .then((normalized: unknown) => {
        if (!linkClickSequenceRef.current.isCurrent(clickSequence)) return;
        if (!normalized || typeof normalized !== 'object') throw new Error('链接规范化返回无效结果');
        // 已阻止默认跳转；只有 main 完成 Node 侧规范化后才广播。
        ctx.message.broadcast('chat.link.clicked', createLinkClickedPayload(normalized as Parameters<typeof createLinkClickedPayload>[0], snapshot));
      })
      .catch((error: unknown) => {
        if (linkClickSequenceRef.current.isCurrent(clickSequence)) logError('链接规范化失败', error);
      });
  }, [ctx]);

  const switchProject = async (nextProject: string) => {
    if (!draft || sending || !nextProject) return;
    setError(null);
    const commandSequence = ++uiStateSequenceRef.current;
    try {
      const snapshot = await requestWithRetry(ctx, 'conversation', 'select', null, { project: nextProject });
      applyUiStateRef.current(snapshot, commandSequence);
    } catch (err) {
      logError('切换项目目录失败', err);
      setError(`切换项目目录失败：${readableErrorMessage(err)}`);
    }
  };


  const selectedModelOption = models.find((item) => item.id === model);
  const reasoningOptions = selectedModelOption?.reasoningEfforts?.length ? selectedModelOption.reasoningEfforts : (reasoningEffort ? [{ id: reasoningEffort, name: reasoningEffort }] : []);
  const serviceTierOptions = selectedModelOption?.serviceTiers?.length ? selectedModelOption.serviceTiers : (serviceTier ? [{ id: serviceTier, name: serviceTier }] : []);
  const selectModel = (nextModel: string): void => {
    const next = models.find((item) => item.id === nextModel);
    setModel(nextModel);
    setReasoningEffort(optionValue(next?.reasoningEfforts, undefined, next?.defaultReasoningEffort));
    setServiceTier(optionValue(next?.serviceTiers, undefined, next?.defaultServiceTier));
  };
  const stageText = (): void => {
    const trimmed = text.trim();
    if (!trimmed) {
      if (pendingMessages.length > 0) void send(pendingMessages.join('\n'));
      return;
    }
    setPendingMessages((current) => [...current, trimmed]);
    setText('');
  };

  const composer = <div className="composer-shell">
    {pendingMessages.length > 0 && <div className="composer-pending" aria-label="待发送内容">
      <div className="composer-pending-label">待发送 · {pendingMessages.length} 段</div>
      {pendingMessages.map((item, index) => <div className="composer-pending-item" key={`${index}-${item}`}><span>{item}</span><button type="button" onClick={() => setPendingMessages((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={`移除第 ${index + 1} 段`}>×</button></div>)}
    </div>}
    <textarea value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); stageText(); } }} placeholder="随心输入，回车暂存；空白回车发送，Shift + Enter 换行" rows={draft ? 5 : 2} disabled={loading || sending || permissionRequests.length > 0} />
    <div className="composer-toolbar" ref={toolbarRef}>
      <OptionPicker
        label="模型"
        icon="⚓"
        className="model-picker"
        compact={toolbarCompact}
        value={model}
        options={(models.length ? models : [{ id: '', name: fallbackModel(source) }]).map((item) => ({ value: item.id, label: item.name }))}
        onChange={selectModel}
      />
      {reasoningOptions.length > 0 && <OptionPicker
        label="推理深度"
        icon="◇"
        className="reasoning-picker"
        compact={toolbarCompact}
        value={reasoningEffort}
        options={reasoningOptions.map((item) => ({ value: item.id, label: item.name, title: item.description }))}
        onChange={setReasoningEffort}
      />}
      {serviceTierOptions.length > 0 && <OptionPicker
        label="服务档位"
        icon="⚡"
        className="service-tier-picker"
        compact={toolbarCompact}
        value={serviceTier}
        options={serviceTierOptions.map((item) => ({ value: item.id, label: item.name, title: item.description }))}
        onChange={setServiceTier}
      />}
      {permissionOptions?.sandboxModes.length ? <OptionPicker
        label="权限范围"
        icon="◈"
        className="permission-picker"
        compact={toolbarCompact}
        disabled={sending}
        value={sandboxMode}
        options={permissionOptions.sandboxModes.map((item) => ({ value: item, label: item === 'read-only' ? '只读' : item === 'workspace-write' ? '工作区可写' : '完全访问' }))}
        onChange={(value) => void updateConversationPermissions(value as SandboxMode, approvalPolicy)}
      /> : null}
      {permissionOptions?.approvalPolicies.length ? <OptionPicker
        label="审批策略"
        icon="✓"
        className="permission-picker"
        compact={toolbarCompact}
        disabled={sending}
        value={approvalPolicy}
        options={permissionOptions.approvalPolicies.map((item) => ({ value: item, label: approvalPolicyLabel(item), title: item === 'always' ? '始终：自动允许权限请求' : undefined }))}
        onChange={(value) => void updateConversationPermissions(sandboxMode, value as ApprovalPolicy)}
      /> : null}
      {contextUsage && <ContextRing ratio={contextUsage.usageRatio} tokens={contextUsage.usedTokens} max={contextUsage.contextWindow} />}
      {sending && conversationId ? (
        <button type="button" className="stop-button" onClick={() => void stopConversation()} disabled={stopping} title={stopping ? '终止中…' : '终止当前对话'} aria-label={stopping ? '终止中' : '终止当前对话'}><span className="stop-icon">■</span></button>
      ) : (
        <button type="button" className="send-button" onClick={() => void send()} disabled={(!text.trim() && pendingMessages.length === 0) || loading || sending || permissionRequests.length > 0 || Boolean(configurationError)} title="发送消息" aria-label="发送消息">↑</button>
      )}
    </div>
  </div>;

  const handleMessageListScroll = (event: UIEvent<HTMLDivElement>): void => {
    const list = event.currentTarget;
    // DOM 布局变化可能在待执行的 RAF 前触发被动 scroll；不能因此取消原本的底部跟随。
    if (shouldIgnorePendingBottomScroll(bottomScrollFrameRef.current !== null, 'passive')) return;
    shouldFollowLatestRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
    if (list.scrollTop <= 48 && conversationId && traceHasMore && !traceOlderLoadingRef.current) void loadOlderTrace(conversationId);
  };
  const cancelPendingBottomScrollForUser = (): void => { cancelBottomScroll(); };
  return <div className="chat">
    {projectPickerOpen && (
      <DirectoryPicker
        ctx={ctx}
        initialPath={project}
        onCancel={() => setProjectPickerOpen(false)}
        onConfirm={(path) => { setProjectPickerOpen(false); void switchProject(path); }}
      />
    )}
    {(error || configurationError) && <div role="alert" className="error-alert">{error || configurationError}</div>}
    <div
      className="message-list-container"
      ref={messageListRef}
      onScroll={handleMessageListScroll}
      onWheel={cancelPendingBottomScrollForUser}
      onPointerDown={cancelPendingBottomScrollForUser}
      onTouchStart={cancelPendingBottomScrollForUser}
      onKeyDown={cancelPendingBottomScrollForUser}
    >
      {!conversationId && !draft ? <div className="empty-state"><div className="empty-state-card"><div className="empty-state-mark">✦</div><h2>选择或新建一个对话</h2><p>从左侧项目中继续工作，或点击"新对话"开始。</p></div></div> : (
        <>
          {loading && !draft && messages.length === 0 && traceTurns.length === 0 && <div className="conversation-loading">正在加载对话…</div>}
          {traceHasMore && <button type="button" className="message-history-loader" onClick={() => conversationId && void loadOlderTrace(conversationId)} disabled={traceOlderLoading}>{traceOlderLoading ? '正在加载更早回合…' : '加载更早回合'}</button>}
          {createElement(Transcript, {
            key: conversationId ? `conversation:${conversationId}` : draft ? `draft:${source}:${project || ''}` : 'empty',
            draft,
            project,
            modelLabel: models.find((item) => item.id === model)?.name || fallbackModel(source),
            messages,
            traceTurns,
            localProcessEntries,
            turnOffset: 0,
            permissionRequests,
            resolvingPermissionId,
            onResolvePermission: resolvePermission,
            sending,
            conversationActive: Boolean(conversationId && activeConversationsRef.current.has(conversationId)),
            onChangeProject: () => setProjectPickerOpen(true),
            onLinkClick: handleLinkClick,
            messageRequest: ctx.message.request,
          })}
        </>
      )}
    </div>
    {(conversationId || draft) && <div className="message-input-container">{composer}</div>}
  </div>;
}
