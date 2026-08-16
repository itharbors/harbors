import type { AgentConversation, AgentChatMessage } from './base.js';

/**
 * Codex app-server thread/list 与 thread/read 的纯类型与映射模块。
 * 仅包含类型定义与纯函数，不涉及 IO、进程或 React。
 */

/** 用户输入内容块，目前只精确建模 text 类型。 */
export interface UserInput {
  type: string;
  text?: string;
}

/** 用户消息项：包含若干 UserInput 内容块。 */
export interface UserMessageItem {
  type: 'userMessage';
  id: string;
  content?: UserInput[];
}

/** 助手消息项：直接携带文本。 */
export interface AgentMessageItem {
  type: 'agentMessage';
  id: string;
  text?: string;
}

/**
 * 其他未精确建模的 item。
 * 仅保证存在 type 与 id，其余字段以 unknown 安全收窄，禁止 any。
 */
export interface UnknownItem {
  type: string;
  id: string;
  [key: string]: unknown;
}

/** Thread item 联合类型：精确建模 user/agent，其余走 UnknownItem。 */
export type ThreadItem = UserMessageItem | AgentMessageItem | UnknownItem;

/** 单个 turn，按本机 generate-ts 结构建模。 */
export interface ThreadTurn {
  id: string;
  items?: ThreadItem[];
  startedAt?: number;
  completedAt?: number;
}

/** thread/list 返回的线程摘要信息。 */
export interface ThreadInfo {
  id: string;
  name: string | null;
  preview?: string;
  createdAt?: number;
  updatedAt?: number;
  recencyAt?: number;
  cwd?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
}

/** thread/list 响应。 */
export interface ThreadListResult {
  data?: ThreadInfo[];
  nextCursor?: string | null;
}

/** thread/read 响应。 */
export interface ThreadReadResult {
  thread?: {
    id: string;
    turns?: ThreadTurn[];
  };
}

/** turn/start 响应。 */
export interface TurnStartResult {
  turn?: {
    id: string;
  };
}

/**
 * 取多行文本中的第一个非空行（trim 后）。
 * 用于在 name 缺失时从 preview 推导对话标题。
 */
function firstNonEmptyLine(text: string | undefined | null): string {
  if (!text) return '';
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

/**
 * 将 Unix 秒级时间戳转换为 ISO 字符串。
 * 缺失或无效（NaN / 非有限数）时返回 undefined，由调用方决定是否省略字段。
 */
function secondsToIso(seconds: number | undefined | null): string | undefined {
  if (seconds === undefined || seconds === null) return undefined;
  if (!Number.isFinite(seconds)) return undefined;
  const date = new Date(seconds * 1000);
  const time = date.getTime();
  if (!Number.isFinite(time)) return undefined;
  return date.toISOString();
}

/**
 * 将 Codex ThreadInfo 映射为统一的 AgentConversation。
 *
 * 标题优先级：name.trim() > preview 第一个非空行 > "未命名对话"。
 * preview 原样透传；createdAt/updatedAt 从 Unix 秒转为 ISO，无效或缺失则省略。
 */
export function mapThreadToConversation(thread: ThreadInfo): AgentConversation {
  const title =
    (thread.name?.trim() || '') ||
    firstNonEmptyLine(thread.preview) ||
    '未命名对话';

  const conversation: AgentConversation = {
    id: thread.id,
    title,
  };

  if (thread.preview !== undefined) {
    conversation.preview = thread.preview;
  }

  const createdAt = secondsToIso(thread.createdAt);
  if (createdAt !== undefined) {
    conversation.createdAt = createdAt;
  }

  const updatedAt = secondsToIso(thread.updatedAt);
  if (updatedAt !== undefined) {
    conversation.updatedAt = updatedAt;
  }

  if (thread.cwd?.trim()) {
    conversation.project = thread.cwd;
  }
  if (thread.model?.trim()) {
    conversation.model = thread.model;
  }
  if (thread.reasoningEffort?.trim()) {
    conversation.reasoningEffort = thread.reasoningEffort;
  }
  if (thread.serviceTier?.trim()) {
    conversation.serviceTier = thread.serviceTier;
  }

  return conversation;
}

/** 判断 item 是否为 userMessage。 */
function isUserMessageItem(item: ThreadItem): item is UserMessageItem {
  return item.type === 'userMessage';
}

/** 判断 item 是否为 agentMessage。 */
function isAgentMessageItem(item: ThreadItem): item is AgentMessageItem {
  return item.type === 'agentMessage';
}

/**
 * 从 userMessage 的 content 中拼接所有 type=text 的非空文本，以换行分隔。
 * 若没有任何有效文本则返回空字符串。
 */
function userMessageText(item: UserMessageItem): string {
  if (!item.content || item.content.length === 0) return '';
  const parts: string[] = [];
  for (const input of item.content) {
    if (input.type !== 'text') continue;
    const text = input.text;
    if (typeof text !== 'string') continue;
    const trimmed = text.trim();
    if (trimmed) parts.push(text);
  }
  return parts.join('\n');
}

/**
 * 将 thread/read 结果按 turns/items 原序映射为 AgentChatMessage 列表。
 *
 * - userMessage：拼接 content 中 type=text 的非空 text（换行分隔），role=user，timestamp 取 turn.startedAt。
 * - agentMessage：使用非空 text，role=assistant，timestamp 取 turn.completedAt。
 * - 其他 item 或空文本一律忽略。
 * - id 直接使用 item.id，保持稳定。
 */
export function mapThreadMessages(result: ThreadReadResult): AgentChatMessage[] {
  const messages: AgentChatMessage[] = [];
  const turns = result.thread?.turns;
  if (!turns || turns.length === 0) return messages;

  for (const turn of turns) {
    const items = turn.items;
    if (!items || items.length === 0) continue;

    const userTimestamp = secondsToIso(turn.startedAt);
    const assistantTimestamp = secondsToIso(turn.completedAt);

    for (const item of items) {
      if (isUserMessageItem(item)) {
        const content = userMessageText(item);
        if (!content) continue;
        const message: AgentChatMessage = {
          id: item.id,
          role: 'user',
          content,
        };
        if (userTimestamp !== undefined) {
          message.timestamp = userTimestamp;
        }
        messages.push(message);
      } else if (isAgentMessageItem(item)) {
        const text = item.text;
        if (typeof text !== 'string') continue;
        const content = text.trim();
        if (!content) continue;
        const message: AgentChatMessage = {
          id: item.id,
          role: 'assistant',
          content: text,
        };
        if (assistantTimestamp !== undefined) {
          message.timestamp = assistantTimestamp;
        }
        messages.push(message);
      }
      // 其他类型 item 忽略
    }
  }

  return messages;
}
