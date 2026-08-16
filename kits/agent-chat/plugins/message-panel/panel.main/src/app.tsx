import { useEffect, useRef, useState } from 'react';
import './index.css';

type Source = 'codex' | 'harbors';
interface MessageData { id: string; role: 'user' | 'assistant'; content: string; }
interface ConversationData { id: string; }
interface DraftData { source?: Source; project?: string; }
interface ModelOption { id: string; name: string; }
function sourceFromId(id: string): Source { return id.startsWith('harbors:') ? 'harbors' : 'codex'; }
function fallbackModel(source: Source): string { return source === 'harbors' ? 'HubBert Relay' : 'Codex 默认模型'; }
function sendErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '未知错误');
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
  const draftActiveRef = useRef(false);

  useEffect(() => {
    if (!shouldFollowLatestRef.current) return;
    const list = messageListRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [conversationId, loading, messages, sending]);

  useEffect(() => {
    let disposed = false;
    const clearConversation = () => { loadSeqRef.current += 1; shouldFollowLatestRef.current = true; draftActiveRef.current = false; conversationIdRef.current = null; setConversationId(null); setMessages([]); setLoading(false); setSending(false); setActivity(null); setError(null); setConfigurationError(null); };
    const enterDraft = (value: unknown) => {
      const draftData = value as DraftData | null;
      clearConversation(); draftActiveRef.current = true; setSource(draftData?.source || 'codex'); setProject(draftData?.project || null); setDraft(true);
    };
    const loadConversation = (id: string) => {
      const seq = ++loadSeqRef.current;
      shouldFollowLatestRef.current = true;
      draftActiveRef.current = false;
      conversationIdRef.current = id;
      setConversationId(id); setSource(sourceFromId(id)); setDraft(false); setProject(null); setLoading(true); setSending(false); setActivity(null); setError(null); setConfigurationError(null); setMessages([]);
      ctx.message.request('agent', 'getMessages', id).then((data: unknown) => { if (!disposed && seq === loadSeqRef.current) { setMessages(Array.isArray(data) ? data as MessageData[] : []); setLoading(false); } }).catch((err: unknown) => { if (!disposed && seq === loadSeqRef.current) { console.error('Failed to load messages:', err); setError('消息加载失败'); setLoading(false); } });
      ctx.message.request('agent', 'getConversationOptions', id).then((options: { models?: ModelOption[]; defaultModel?: string; selectedModel?: string; configurationError?: string }) => {
        if (disposed || seq !== loadSeqRef.current) return;
        const available = Array.isArray(options?.models) ? options.models : [];
        setModels(available);
        setModel(options?.selectedModel || options?.defaultModel || available[0]?.id || '');
        setConfigurationError(options?.configurationError || null);
      }).catch((err: unknown) => { if (!disposed && seq === loadSeqRef.current) { console.error('Failed to load conversation models:', err); setModels([]); setModel(''); } });
    };
    registerSetter('conversation.selected', (value: unknown) => { if (!disposed) { if (value) loadConversation(String(value)); else clearConversation(); } });
    registerSetter('conversation.draft', (value: unknown) => { if (!disposed) enterDraft(value); });
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
    registerSetter('message.sent', (value: unknown) => { const id = (value as { conversationId?: string } | null)?.conversationId; if (id && id === conversationIdRef.current) ctx.message.request('agent', 'getMessages', id).then((data: unknown) => { if (!disposed && id === conversationIdRef.current) setMessages(Array.isArray(data) ? data as MessageData[] : []); }); });
    const initialSequence = loadSeqRef.current;
    ctx.message.request('agent', 'getActiveConversation').then((value: unknown) => {
      if (!disposed && initialSequence === loadSeqRef.current && value) loadConversation(String(value));
    });
    const draftPoll = window.setInterval(() => {
      ctx.message.request('agent', 'getDraftConversation').then((value: unknown) => {
        if (!disposed && value && !draftActiveRef.current) enterDraft(value);
      }).catch(() => undefined);
    }, 500);
    return () => { disposed = true; window.clearInterval(draftPoll); };
  }, [ctx, registerSetter]);

  useEffect(() => {
    if (!draft) return;
    let disposed = false;
    ctx.message.request('agent', 'getDraftOptions', source).then((options: { models?: ModelOption[]; defaultModel?: string; configurationError?: string }) => {
      if (disposed) return;
      const available = Array.isArray(options?.models) ? options.models : [];
      setModels(available);
      setModel(options?.defaultModel || available[0]?.id || '');
      setConfigurationError(options?.configurationError || null);
    }).catch(() => { if (!disposed) { setModels([]); setModel(''); setConfigurationError('无法读取 Agent 配置。'); } });
    return () => { disposed = true; };
  }, [ctx, draft, source]);

  const send = async () => {
    if (!text.trim() || sending || loading || configurationError) return;
    let target = conversationId;
    shouldFollowLatestRef.current = true;
    setSending(true); setActivity('正在准备对话…'); setError(null);
    try {
      if (!target) { const created = await ctx.message.request('agent', 'createConversation', source, project || undefined, model || undefined) as { id: string }; target = created.id; conversationIdRef.current = target; setConversationId(target); setDraft(false); }
      const optimistic: MessageData = { id: `opt-${Date.now()}`, role: 'user', content: text };
      setMessages((current) => [...current, optimistic]); setText('');
      await ctx.message.request('agent', 'sendMessage', target, optimistic.content, model || undefined);
      const latest = await ctx.message.request('agent', 'getMessages', target);
      if (target === conversationIdRef.current) setMessages(Array.isArray(latest) ? latest as MessageData[] : []);
    } catch (err) { console.error('Failed to send message:', err); setError(sendErrorMessage(err)); } finally { setSending(false); setActivity(null); }
  };

  const composer = <div className="composer-shell">
    <textarea value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } }} placeholder="随心输入，Shift + Enter 换行" rows={draft || messages.length === 0 ? 5 : 3} disabled={loading || sending} />
    <div className="composer-toolbar">
      <button type="button" className="composer-add" aria-label="添加上下文" title="添加上下文">＋</button>
      <div className="source-tabs" role="tablist" aria-label="选择 Agent">{(['codex', 'harbors'] as const).map((item) => <button key={item} type="button" role="tab" aria-selected={source === item} className={source === item ? 'selected' : ''} disabled={!draft && source !== item} onClick={() => setSource(item)}>{item === 'codex' ? '⌘ Codex' : '⚓ HubBert'}</button>)}</div>
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
