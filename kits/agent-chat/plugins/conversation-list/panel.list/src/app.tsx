import { useEffect, useRef, useState, type MouseEvent } from 'react';
import './index.css';

interface ConversationData {
  id: string;
  title: string;
  lastMessage?: string;
  preview?: string;
  source: 'codex' | 'harbors';
  project?: string;
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
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sequenceRef = useRef(0);

  useEffect(() => {
    let disposed = false;
    const applyList = (value: unknown) => {
      const list = Array.isArray(value) ? (value as ConversationData[]) : [];
      setConversations(list);
      setActiveId((current) => (current && !list.some((item) => item.id === current) ? null : current));
      return list;
    };

    registerSetter('conversation.changed', (data: unknown) => {
      sequenceRef.current += 1;
      if (!disposed) applyList(data);
    });
    registerSetter('conversation.selected', (data: unknown) => {
      sequenceRef.current += 1;
      if (!disposed) {
        setActiveId(data ? String(data) : null);
        setError(null);
      }
    });
    registerSetter('message.sent', () => {
      const requestId = ++sequenceRef.current;
      ctx.message.request('agent', 'listConversations').then((data: unknown) => {
        if (!disposed && requestId === sequenceRef.current) applyList(data);
      }).catch((err: unknown) => console.error('Failed to refresh conversations:', err));
    });

    const requestId = sequenceRef.current;
    Promise.all([
      ctx.message.request('agent', 'listConversations'),
      ctx.message.request('agent', 'getActiveConversation'),
    ]).then(([listData, selectedData]: [unknown, unknown]) => {
      if (disposed || requestId !== sequenceRef.current) return;
      const list = applyList(listData);
      const selected = selectedData ? String(selectedData) : null;
      if (selected && list.some((item) => item.id === selected)) {
        setActiveId(selected);
        return;
      }
      if (list.length > 0) {
        ctx.message.request('agent', 'selectConversation', list[0].id).catch((err: unknown) => {
          if (!disposed) {
            console.error('Failed to select initial conversation:', err);
            setError('初始化对话失败');
          }
        });
      }
    }).catch((err: unknown) => {
      if (!disposed) {
        console.error('Failed to load conversations:', err);
        setError('加载对话列表失败');
      }
    });

    return () => { disposed = true; };
  }, [ctx, registerSetter]);

  const handleNew = async () => {
    try {
      // 忽略初始化中的旧选择结果，避免它覆盖刚进入的草稿态。
      sequenceRef.current += 1;
      await ctx.message.request('agent', 'startDraftConversation');
      setError(null);
    } catch (err) {
      console.error('Failed to create conversation:', err);
      setError('新建对话失败，请重试');
    }
  };

  const handleSelect = async (id: string) => {
    try {
      await ctx.message.request('agent', 'selectConversation', id);
      setError(null);
    } catch (err) {
      console.error('Failed to select conversation:', err);
      setError('切换对话失败，请重试');
    }
  };

  const handleArchive = async (id: string, event: MouseEvent) => {
    event.stopPropagation();
    try {
      await ctx.message.request('agent', 'deleteConversation', id);
      setError(null);
    } catch (err) {
      console.error('Failed to archive conversation:', err);
      setError('归档对话失败，请重试');
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
                <article key={conversation.id} className={`conversation-card ${activeId === conversation.id ? 'active' : ''}`} role="button" tabIndex={0} onClick={() => handleSelect(conversation.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); handleSelect(conversation.id); } }}>
                  <div className={`source-mark ${harbors ? 'harbors' : 'codex'}`} aria-hidden="true">{harbors ? '⚓' : '⌘'}</div>
                  <div className="conversation-card-content">
                    <div className="conversation-card-title-row">
                      <span className="conversation-card-title">{conversation.title}</span>
                      <span className={`source-badge ${harbors ? 'harbors' : 'codex'}`}>{harbors ? 'HARBORS' : 'CODEX'}</span>
                    </div>
                    <div className="conversation-card-preview">{conversation.lastMessage || conversation.preview || '尚未发送消息'}</div>
                  </div>
                  <button type="button" className="archive-btn" onClick={(event) => handleArchive(conversation.id, event)} aria-label={`归档对话：${conversation.title}`} title="归档对话">归档</button>
                </article>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
