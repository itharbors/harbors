import { useEffect, useRef, useState } from 'react';
import { acceptConversationUiState, createConversationUiStateGate } from './ui-state-gate.js';
import './index.css';

type Source = 'codex' | 'harbors';
interface MessageData { id: string; role: 'user' | 'assistant'; content: string; }
interface ConversationData { id: string; }
interface DraftData { source?: Source; project?: string; }
interface ConversationUiState { selectedConversationId?: string | null; draft?: DraftData | null; generation?: string; revision?: number; }
interface ModelOption { id: string; name: string; }
const REQUEST_RETRY_DELAYS = [0, 100, 250, 500, 1000];

function sourceFromId(id: string): Source { return id.startsWith('harbors:') ? 'harbors' : 'codex'; }
function fallbackModel(source: Source): string { return source === 'harbors' ? 'HubBert Relay' : 'Codex 默认模型'; }
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
function inlineMarkdown(value: string) {
  return value.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((part, index) => {
    if (part.startsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>;
    return part;
  });
}
function MarkdownMessage({ content }: { content: string }) {
  const sections = content.split(/```(?:\w+)?\n?/g);
  return <>{sections.map((section, sectionIndex) => sectionIndex % 2 === 1 ? <pre key={sectionIndex}><code>{section.trim()}</code></pre> : section.split('\n').map((line, lineIndex) => {
    const key = `${sectionIndex}-${lineIndex}`;
    if (line.startsWith('### ')) return <h3 key={key}>{inlineMarkdown(line.slice(4))}</h3>;
    if (line.startsWith('## ')) return <h2 key={key}>{inlineMarkdown(line.slice(3))}</h2>;
    if (line.startsWith('# ')) return <h1 key={key}>{inlineMarkdown(line.slice(2))}</h1>;
    if (/^[-*]\s+/u.test(line)) return <div key={key} className="markdown-list-item">• {inlineMarkdown(line.replace(/^[-*]\s+/u, ''))}</div>;
    if (/^\d+\.\s+/u.test(line)) return <div key={key} className="markdown-list-item">{inlineMarkdown(line)}</div>;
    return line ? <p key={key}>{inlineMarkdown(line)}</p> : <br key={key} />;
  }))}</>;
}

export default function App({ ctx, registerSetter }: { ctx: any; registerSetter: (key: string, setter: (data: any) => void) => void; }) {
  const [messages, setMessages] = useState<MessageData[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [source, setSource] = useState<Source>('codex');
  const [draft, setDraft] = useState(false);
  const [project, setProject] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState('');
  const [configurationError, setConfigurationError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
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

  useEffect(() => {
    if (!shouldFollowLatestRef.current) return;
    const list = messageListRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [conversationId, loading, messages, sending]);

  useEffect(() => {
    let disposed = false;
    const clearConversation = () => { loadSeqRef.current += 1; shouldFollowLatestRef.current = true; conversationIdRef.current = null; setConversationId(null); setDraft(false); setProject(null); setMessages([]); setLoading(false); setSending(false); setActivity(null); setError(null); setConfigurationError(null); };
    const enterDraft = (value: unknown) => {
      const draftData = value as DraftData | null;
      clearConversation(); setSource(draftData?.source || 'codex'); setProject(draftData?.project || null); setDraft(true);
    };
    const loadConversation = (id: string) => {
      const seq = ++loadSeqRef.current;
      const preserveSending = sendingRef.current && (pendingConversationIdRef.current === id || conversationIdRef.current === id);
      shouldFollowLatestRef.current = true;
      conversationIdRef.current = id;
      setConversationId(id); setSource(sourceFromId(id)); setDraft(false); setProject(null); setLoading(true); if (!preserveSending) { setSending(false); setActivity(null); } setError(null); setConfigurationError(null); if (!preserveSending) setMessages([]);
      requestWithRetry(ctx, 'agent', 'getMessages', id).then((data: unknown) => { if (!disposed && seq === loadSeqRef.current) { const loaded = Array.isArray(data) ? data as MessageData[] : []; setMessages((current) => { if (!preserveSending || !sendingRef.current) return loaded; const loadedIds = new Set(loaded.map((message) => message.id)); return [...loaded, ...current.filter((message) => message.id.startsWith('opt-') && !loadedIds.has(message.id))]; }); setLoading(false); } }).catch((err: unknown) => { if (!disposed && seq === loadSeqRef.current) { logError('加载消息失败', err); setError(`消息加载失败：${readableErrorMessage(err)}`); setLoading(false); } });
      requestWithRetry(ctx, 'agent', 'getConversationOptions', id).then((options: unknown) => {
        if (disposed || seq !== loadSeqRef.current) return;
        const typedOptions = options as { models?: ModelOption[]; defaultModel?: string; selectedModel?: string; configurationError?: string };
        const available = Array.isArray(typedOptions?.models) ? typedOptions.models : [];
        setModels(available);
        setModel(typedOptions?.selectedModel || typedOptions?.defaultModel || available[0]?.id || '');
        setConfigurationError(typedOptions?.configurationError || null);
      }).catch((err: unknown) => { if (!disposed && seq === loadSeqRef.current) { logError('加载模型失败', err); setModels([]); setModel(''); setConfigurationError(`无法读取 Agent 配置：${readableErrorMessage(err)}`); } });
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
      const status = value as { conversationId?: string; status?: string } | null;
      if (!disposed && status?.conversationId === conversationIdRef.current && status.status) setActivity(status.status);
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
      const typedOptions = options as { models?: ModelOption[]; defaultModel?: string; configurationError?: string };
      const available = Array.isArray(typedOptions?.models) ? typedOptions.models : [];
      setModels(available);
      setModel(typedOptions?.defaultModel || available[0]?.id || '');
      setConfigurationError(typedOptions?.configurationError || null);
    }).catch((err: unknown) => { if (!disposed) { logError('加载草稿模型失败', err); setModels([]); setModel(''); setConfigurationError(`无法读取 Agent 配置：${readableErrorMessage(err)}`); } });
    return () => { disposed = true; };
  }, [ctx, draft, source]);

  const send = async () => {
    if (!text.trim() || sending || sendingRef.current || loading || configurationError) return;
    let target = conversationId;
    shouldFollowLatestRef.current = true;
    sendingRef.current = true;
    setSending(true); setActivity('正在准备对话…'); setError(null);
    try {
      if (!target) {
        const created = await ctx.message.request('agent', 'createConversation', source, project || undefined, model || undefined) as { id: string };
        target = created.id;
        pendingConversationIdRef.current = target;
        const selectionSequence = ++uiStateSequenceRef.current;
        const snapshot = await requestWithRetry(ctx, 'conversation-list', 'selectConversation', target);
        applyUiStateRef.current(snapshot, selectionSequence);
      }
      const optimistic: MessageData = { id: `opt-${Date.now()}`, role: 'user', content: text };
      setMessages((current) => [...current, optimistic]); setText('');
      await ctx.message.request('agent', 'sendMessage', target, optimistic.content, model || undefined);
      const latest = await ctx.message.request('agent', 'getMessages', target);
      if (target === conversationIdRef.current) setMessages(Array.isArray(latest) ? latest as MessageData[] : []);
    } catch (err) { logError('发送消息失败', err); setError(sendErrorMessage(err)); } finally { sendingRef.current = false; if (pendingConversationIdRef.current === target) pendingConversationIdRef.current = null; setSending(false); setActivity(null); }
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

  const composer = <div className="composer-shell">
    <textarea value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } }} placeholder="随心输入，Shift + Enter 换行" rows={draft || messages.length === 0 ? 5 : 3} disabled={loading || sending} />
    <div className="composer-toolbar">
      <button type="button" className="composer-add" aria-label="添加上下文" title="添加上下文">＋</button>
      <div className="source-tabs" role="tablist" aria-label="选择 Agent">{(['codex', 'harbors'] as const).map((item) => <button key={item} type="button" role="tab" aria-selected={source === item} className={source === item ? 'selected' : ''} disabled={!draft && source !== item} onClick={() => void switchSource(item)}>{item === 'codex' ? '⌘ Codex' : '⚓ HubBert'}</button>)}</div>
      <label className="model-picker">模型<select value={model} disabled={models.length < 2} onChange={(event) => setModel(event.target.value)}>{models.length ? models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>) : <option value="">{fallbackModel(source)}</option>}</select></label>
      <button type="button" className="send-button" onClick={send} disabled={!text.trim() || loading || sending || Boolean(configurationError)} aria-label="发送消息">↑</button>
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
        {messages.map((message) => <article key={message.id} className={`chat-message ${message.role}`}><div className="chat-message-content"><MarkdownMessage content={message.content} /></div></article>)}
        {sending && <div className="sending-indicator">{activity || (messages.some((message) => message.role === 'assistant' && !message.content) ? '正在生成回复…' : '正在请求模型…')}</div>}
      </div>}
    </div>
    {(conversationId || draft) && <div className="message-input-container">{composer}</div>}
  </div>;
}
