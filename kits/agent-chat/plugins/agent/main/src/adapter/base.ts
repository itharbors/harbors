/**
 * 统一 Agent Adapter 接口。
 * 当前实现 Codex 与 Harbors 自主管理的 agent。
 */

export type AgentSource = 'codex' | 'harbors';

export interface AgentConversation {
  id: string;
  title: string;
  preview?: string;
  createdAt?: string;
  updatedAt?: string;
  /** 会话所属工作目录；用于按项目组织会话列表。 */
  project?: string;
  /** 此会话最近一次用于发送的模型。 */
  model?: string;
  /** 聚合列表中标识会话来源；底层 adapter 返回时可省略。 */
  source?: AgentSource;
}

export interface AgentChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp?: string;
  /** 工具名称（role=tool 时存在） */
  toolName?: string;
  /** 工具调用是否失败（role=tool 时存在） */
  isError?: boolean;
}

/** 工具调用事件，在 agent 执行工具时实时回调。 */
export interface AgentToolCall {
  name: string;
  result: string;
  isError: boolean;
}

/** DeepSeek Harness 风格的只追加会话事件。 */
export interface AgentTraceEvent {
  type: string;
  seq: number;
  time: number;
  data: Record<string, unknown>;
  ignorable?: true;
}

export interface AgentAdapter {
  /** 创建新对话 */
  createConversation(project?: string, model?: string): Promise<AgentConversation>;

  /** 返回新建会话时可供选择的模型；不支持时由宿主提供保守默认值。 */
  getModels?(): Promise<{ models: Array<{ id: string; name: string }>; defaultModel: string; configurationError?: string }>;

  /** 列出所有对话 */
  listConversations(): Promise<AgentConversation[]>;

  /** 删除对话 */
  deleteConversation(id: string): Promise<void>;

  /** 获取对话历史消息 */
  getMessages(conversationId: string): Promise<AgentChatMessage[]>;

  /** 获取对话的 Agent 执行轨迹；不支持轨迹的 adapter 返回空数组。 */
  getConversationTrace?(conversationId: string, turnId?: string): Promise<AgentTraceEvent[]>;

  /** 发送消息；支持的 adapter 会在回复完成前通过 onDelta 交付增量文本。 */
  sendMessage(conversationId: string, content: string, model?: string, onDelta?: (delta: string) => void, onStatus?: (status: string) => void): Promise<string>;

  /** 停止 adapter，终止底层 client 并拒绝/清理所有未完成 turn */
  stop(): void;
}
