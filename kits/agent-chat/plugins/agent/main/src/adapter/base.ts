/**
 * 统一 Agent Adapter 接口。
 * 当前实现 Harbors 自主管理的 agent。
 */

export type AgentSource = 'harbors';

export type AgentSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export const AGENT_SANDBOX_MODES: readonly AgentSandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];

export type AgentApprovalPolicy = 'ask' | 'always';
export const AGENT_APPROVAL_POLICIES: readonly AgentApprovalPolicy[] = ['ask', 'always'];

export type AgentPermissionOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

export type AgentProgressPhase = 'running' | 'waiting_permission' | 'completed' | 'error';

export interface AgentProgressStatus {
  phase: AgentProgressPhase;
  message?: string;
  turn?: number;
  step?: number;
  contextUsage?: AgentContextUsage;
}

export interface AgentPermissionState {
  sandboxMode: AgentSandboxMode;
  approvalPolicy: AgentApprovalPolicy;
}

export interface AgentPermissionRequest {
  requestId: string;
  conversationId: string;
  turn: number;
  step: number;
  toolName: string;
  currentMode: AgentSandboxMode;
  requestedMode: AgentSandboxMode;
  justification: string;
  signal?: AbortSignal;
}

export type AgentPermissionRequester = (request: AgentPermissionRequest) => Promise<AgentPermissionOutcome>;

export interface AgentOption {
  id: string;
  name: string;
  description?: string;
}

export interface AgentModelOption extends AgentOption {
  reasoningEfforts?: AgentOption[];
  serviceTiers?: AgentOption[];
  defaultReasoningEffort?: string;
  defaultServiceTier?: string;
  /** Model context capacity used by the adapter's compaction policy. */
  contextWindow?: number;
}

/** 单次模型请求的真实 Token 用量；字段名统一为 Harness 风格。 */
export interface AgentTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/** 当前会话的上下文容量与估算占用。 */
export interface AgentContextUsage {
  model: string;
  contextWindow: number;
  usedTokens: number;
  usageRatio: number;
  estimated: true;
  /** 已记录的模型请求累计用量；历史记录没有 provider usage 时省略。 */
  tokenUsage?: AgentTokenUsage;
}

export interface AgentTurnOptions {
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  sandboxMode?: AgentSandboxMode;
  approvalPolicy?: AgentApprovalPolicy;
}

export type AgentTurnInput = string | AgentTurnOptions | undefined;

export interface AgentOptions {
  models: AgentModelOption[];
  defaultModel: string;
  defaultReasoningEffort?: string;
  defaultServiceTier?: string;
  contextUsage?: AgentContextUsage;
  configurationError?: string;
  permissions?: {
    sandboxModes: AgentSandboxMode[];
    approvalPolicies: AgentApprovalPolicy[];
    defaultSandboxMode: AgentSandboxMode;
    defaultApprovalPolicy: AgentApprovalPolicy;
  };
}

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
  /** 此会话最近一次使用的推理强度。 */
  reasoningEffort?: string;
  /** 此会话最近一次使用的服务档位。 */
  serviceTier?: string;
  /** 此会话当前的文件沙盒模式。 */
  sandboxMode?: AgentSandboxMode;
  /** 此会话当前的审批策略。 */
  approvalPolicy?: AgentApprovalPolicy;
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
  /** How this event enters the model-visible surface. */
  surfaceOp?: 'append' | { op: 'replace'; start: number; end: number };
  /** Earlier events cited as the source of a replacement or derived message. */
  sourceEventSeqs?: number[];
  ignorable?: true;
}

export interface AgentAdapter {
  /** 创建新对话 */
  createConversation(project?: string, options?: AgentTurnInput): Promise<AgentConversation>;

  /** 返回新建会话时可供选择的模型；不支持时由宿主提供保守默认值。 */
  getModels?(): Promise<AgentOptions>;

  /** 列出所有对话 */
  listConversations(): Promise<AgentConversation[]>;

  /** 删除对话 */
  deleteConversation(id: string): Promise<void>;

  /** 重命名对话；返回更新后的会话摘要。不支持的 adapter 可省略。 */
  renameConversation?(id: string, title: string): Promise<AgentConversation>;

  /** 获取会话最近一次使用的配置；不支持时返回空对象。 */
  getConversationSettings?(conversationId: string): Promise<AgentTurnOptions>;

  /** 获取会话当前的上下文容量与估算占用。 */
  getConversationContext?(conversationId: string): Promise<AgentContextUsage | undefined>;

  /** 获取会话当前的权限状态。 */
  getConversationPermissions?(conversationId: string): Promise<AgentPermissionState>;

  /** 更新会话权限状态；未提供的字段保持不变。 */
  setConversationPermissions?(conversationId: string, permissions: Partial<AgentPermissionState>): Promise<AgentPermissionState>;

  /** 设置工具越权审批的宿主回调；未设置时审批失败关闭。 */
  setPermissionRequester?(requester?: AgentPermissionRequester): void;

  /** 获取对话的 Agent 执行轨迹；不支持轨迹的 adapter 返回空数组。 */
  getConversationTrace?(conversationId: string, turnId?: string): Promise<AgentTraceEvent[]>;

  /** 发送消息；支持的 adapter 会在回复完成前通过 onDelta 交付增量文本。 */
  sendMessage(conversationId: string, content: string, options?: AgentTurnInput, onDelta?: (delta: string) => void, onStatus?: (status: string) => void): Promise<string>;

  /** 停止指定会话当前正在执行的 turn；返回是否确实存在可停止的 turn。 */
  stopConversation?(conversationId: string): Promise<boolean>;

  /** 停止 adapter，终止底层 client 并拒绝/清理所有未完成 turn */
  stop(): void;
}

export function normalizeTurnOptions(input: AgentTurnInput): AgentTurnOptions {
  if (typeof input === 'string') return input ? { model: input } : {};
  return input ? { ...input } : {};
}
