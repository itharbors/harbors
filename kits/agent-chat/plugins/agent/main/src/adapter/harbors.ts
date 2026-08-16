import { appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentChatMessage, AgentConversation, AgentTraceEvent } from './base.js';
import { readDshRelayConfig, type RelayModel } from './dsh-config.js';
import { resolveDshCredential } from './credentials.js';
import { hubbertTools, runHubBertToolContent, type HubBertToolImage } from './tools.js';

interface StoredSession {
  id: string;
  title: string;
  project?: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
  messages: AgentChatMessage[];
  events: AgentTraceEvent[];
  logPath?: string;
}

interface SessionHeader {
  type: 'session';
  version: 0;
  id: string;
  createdAt: number;
  cwd?: string;
  model?: string;
}

const REQUEST_TIMEOUT_MS = 5 * 60_000;
const SESSION_FORMAT_VERSION = 0;
const MAX_STORED_VALUE_CHARS = 12_000;

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Harbors adapter has been stopped');
}

function requestSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
}

/** Harbors 自主管理的 agent：参考 Harness，用只追加事件日志维护 session/turn。 */
export class HarborsAdapter implements AgentAdapter {
  private stopped = false;
  private readonly abortController = new AbortController();
  private readonly storageDir = resolve(process.env.HARBORS_AGENT_STORAGE_DIR || process.env.HARBORS_PI_AGENT_STORAGE_DIR || join(homedir(), '.harbors', 'pi-agent', 'sessions'));
  private eventWriteQueue: Promise<void> = Promise.resolve();

  async createConversation(project?: string, model?: string): Promise<AgentConversation> {
    throwIfAborted(this.abortController.signal);
    const now = new Date();
    const id = randomUUID();
    const session: StoredSession = {
      id,
      title: '未命名对话',
      ...(project ? { project } : {}),
      ...(model ? { model } : {}),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      messages: [],
      events: [],
      logPath: this.logPathFor(id),
    };
    await mkdir(this.storageDir, { recursive: true });
    await writeFile(session.logPath, `${JSON.stringify(this.headerFor(session))}\n`, 'utf8');
    return toConversation(session);
  }

  async listConversations(): Promise<AgentConversation[]> {
    await mkdir(this.storageDir, { recursive: true });
    const entries = await readdir(this.storageDir, { withFileTypes: true });
    const paths = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')).map((entry) => join(this.storageDir, entry.name));
    const sessions = await Promise.all(paths.map((path) => this.loadByPath(path).catch(() => null)));
    return sessions.filter((session): session is StoredSession => session !== null).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).map(toConversation);
  }

  async deleteConversation(id: string): Promise<void> {
    throwIfAborted(this.abortController.signal);
    const session = await this.load(id);
    const source = session.logPath;
    if (!source) throw new Error(`Harbors session has no storage path: ${id}`);
    const trashDir = join(this.storageDir, '.harbors-trash');
    await mkdir(trashDir, { recursive: true });
    await rename(source, join(trashDir, `${id}-${Date.now()}.jsonl`));
  }

  async getMessages(id: string): Promise<AgentChatMessage[]> {
    return (await this.load(id)).messages.map((message) => ({ ...message }));
  }

  async getConversationTrace(id: string, turnId?: string): Promise<AgentTraceEvent[]> {
    const events = (await this.load(id)).events;
    return events.filter((event) => !turnId || String(event.data.turn) === turnId).map((event) => ({ ...event, data: { ...event.data } }));
  }

  async sendMessage(id: string, content: string, model?: string, _onDelta?: (delta: string) => void, onStatus?: (status: string) => void): Promise<string> {
    if (this.stopped) throw new Error('Harbors adapter has been stopped');
    const session = await this.load(id);
    if (model) session.model = model;
    const turn = nextTurnNumber(session.events);
    const userMessageId = randomUUID();
    if (session.title === '未命名对话') session.title = content.trim().slice(0, 48) || session.title;
    await this.appendEvent(session, 'turn/start', { turn });
    await this.appendEvent(session, 'user/message', { content: [{ type: 'text', text: content }], source: { kind: 'user' }, role: 'user', id: userMessageId });
    if (session.events.filter((event) => event.type === 'user/message').length === 1) await this.appendEvent(session, 'session/title', { title: session.title, messageSeqs: [session.events.at(-1)?.seq] });
    try {
      const response = await this.runTurn(session, turn, onStatus);
      await this.appendEvent(session, 'turn/end', { turn, reason: { kind: 'completed' } });
      return response;
    } catch (error) {
      const normalized = normalizeError(error);
      await this.appendEvent(session, 'turn/end', { turn, reason: { kind: 'error', error: { message: normalized, code: 'UNKNOWN' } } });
      throw error;
    }
  }

  stop(): void { this.stopped = true; this.abortController.abort(); }

  async getModels(): Promise<{ models: RelayModel[]; defaultModel: string; configurationError?: string }> {
    const config = await this.config();
    const models = config.models.length ? config.models : [{ id: config.modelId, name: config.modelId }];
    const configurationError = !config.baseUrl
      ? 'HubBert 未找到 Relay 地址：请检查 ~/.dsh/settings.yaml 或 HARBORS_RELAY_BASE_URL。'
      : !config.apiKey
        ? 'HubBert 缺少 DSH Relay 凭据：请在启动 Harbors 前设置 ~/.dsh/settings.yaml 中 apiKeyEnv 指向的环境变量。'
        : undefined;
    return { models, defaultModel: config.defaultModel || models[0].id, ...(configurationError ? { configurationError } : {}) };
  }

  private async runTurn(session: StoredSession, turn: number, onStatus?: (status: string) => void): Promise<string> {
    const signal = this.abortController.signal;
    const config = await this.config();
    throwIfAborted(signal);
    const { baseUrl, apiKey, api, modelId } = config;
    if (!baseUrl) throw new Error('HubBert agent requires HARBORS_RELAY_BASE_URL or ~/.dsh/settings.yaml');
    if (!apiKey) throw new Error('HubBert agent requires HARBORS_RELAY_API_KEY or the DSH apiKeyEnv environment variable');
    const model = session.model || modelId;
    if (api === 'anthropic-messages') return this.runAnthropicToolLoop(session, turn, baseUrl, apiKey, model, onStatus, signal);
    if (api === 'openai-completions') return this.runOpenAiToolLoop(session, turn, baseUrl, apiKey, model, onStatus, signal);
    throw new Error(`Unsupported Harbors relay API: ${api}`);
  }

  private async runAnthropicToolLoop(session: StoredSession, turn: number, baseUrl: string, apiKey: string, model: string, onStatus: ((status: string) => void) | undefined, signal: AbortSignal): Promise<string> {
    const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = toAnthropicMessages(session.events);
    const workspace = process.env.HARBORS_AGENT_WORKSPACE || session.project || process.cwd();
    // 与 DeepSeek Harness 一致：turn 不内置 step 预算，由完成、取消、超时或错误结束。
    let step = 1;
    while (true) {
      await this.appendEvent(session, 'step/start', { turn, step });
      try {
        throwIfAborted(signal);
        onStatus?.(step > 1 ? '正在根据工具结果继续推理…' : '正在请求 HubBert…');
        await this.appendEvent(session, 'request/context', { turn, step, provider: 'harbors', model, api: 'anthropic-messages' });
        const response = await fetch(`${baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 16_384, tools: hubbertTools, messages }), signal: requestSignal(signal) });
        if (!response.ok) throw new Error(`Harbors relay request failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
        const payload = await response.json() as { content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }> };
        const blocks = payload.content || [];
        const calls = blocks.filter((block) => block.type === 'tool_use' && block.id && block.name).map((call) => ({ id: call.id!, name: call.name!, input: call.input || {}, arguments: boundedJson(call.input || {}) }));
        await this.appendEvent(session, 'assistant/message', { turn, step, message: { role: 'assistant', content: blocks, source: { kind: 'model', provider: 'harbors', model }, id: randomUUID() } });
        if (!calls.length) {
          const text = blocks.filter((block) => block.type === 'text').map((block) => block.text || '').join('');
          if (!text) throw new Error('Harbors agent returned no text response');
          await this.appendEvent(session, 'step/end', { turn, step });
          return text;
        }
        for (const call of calls) await this.appendEvent(session, 'tool/call', { turn, step, callId: call.id, name: call.name, arguments: call.arguments });
        const results = await this.executeToolCalls(calls, workspace, signal, onStatus, session, turn, step);
        const anthropicResults = results.map((result, index) => ({ type: 'tool_result', tool_use_id: calls[index].id, ...(result.isError ? { is_error: true } : {}), content: result.image ? [{ type: 'text', text: result.content }, anthropicImageBlock(result.image)] : result.content }));
        messages.push({ role: 'assistant', content: blocks });
        messages.push({ role: 'user', content: anthropicResults });
        await this.appendEvent(session, 'step/end', { turn, step });
        step += 1;
      } catch (error) {
        await this.appendEvent(session, 'step/end', { turn, step }).catch(() => undefined);
        throw error;
      }
    }
  }

  private async runOpenAiToolLoop(session: StoredSession, turn: number, baseUrl: string, apiKey: string, model: string, onStatus: ((status: string) => void) | undefined, signal: AbortSignal): Promise<string> {
    const workspace = process.env.HARBORS_AGENT_WORKSPACE || session.project || process.cwd();
    const messages: Array<Record<string, unknown>> = toOpenAiMessages(session.events);
    const tools = hubbertTools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema } }));
    // 与 DeepSeek Harness 一致：turn 不内置 step 预算，由完成、取消、超时或错误结束。
    let step = 1;
    while (true) {
      await this.appendEvent(session, 'step/start', { turn, step });
      try {
        throwIfAborted(signal);
        onStatus?.(step > 1 ? '正在根据工具结果继续推理…' : '正在请求 HubBert…');
        await this.appendEvent(session, 'request/context', { turn, step, provider: 'harbors', model, api: 'openai-completions' });
        const response = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: false, messages, tools }), signal: requestSignal(signal) });
        if (!response.ok) throw new Error(`Harbors relay request failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
        const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown; tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }> } }> };
        const message = payload.choices?.[0]?.message;
        if (!message) throw new Error('Harbors agent returned no message');
        const calls = (message.tool_calls || []).filter((call) => call.id && call.function?.name).map((call) => ({ id: call.id!, name: call.function!.name!, input: parseToolArguments(call.function!.arguments), arguments: boundedText(call.function!.arguments || '{}') }));
        await this.appendEvent(session, 'assistant/message', { turn, step, message: { role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls, source: { kind: 'model', provider: 'harbors', model }, id: randomUUID() } });
        if (!calls.length) {
          const text = textContent(message.content);
          if (!text) throw new Error('Harbors agent returned no text response');
          await this.appendEvent(session, 'step/end', { turn, step });
          return text;
        }
        for (const call of calls) await this.appendEvent(session, 'tool/call', { turn, step, callId: call.id, name: call.name, arguments: call.arguments });
        messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls });
        const results = await this.executeToolCalls(calls, workspace, signal, onStatus, session, turn, step);
        results.forEach((result, index) => messages.push({ role: 'tool', tool_call_id: calls[index].id, content: result.content }));
        const images = results.filter((result) => result.image);
        if (images.length) messages.push({ role: 'user', content: images.flatMap((result) => [{ type: 'text', text: result.content }, openAiImagePart(result.image!)]), });
        await this.appendEvent(session, 'step/end', { turn, step });
        step += 1;
      } catch (error) {
        await this.appendEvent(session, 'step/end', { turn, step }).catch(() => undefined);
        throw error;
      }
    }
  }

  private async executeToolCalls(calls: ToolCall[], workspace: string, signal: AbortSignal, onStatus: ((status: string) => void) | undefined, session: StoredSession, turn: number, step: number): Promise<ToolResult[]> {
    const results = new Array<ToolResult>(calls.length);
    let index = 0;
    while (index < calls.length) {
      if (isParallelTool(calls[index].name)) {
        const start = index;
        while (index < calls.length && isParallelTool(calls[index].name)) index += 1;
        const group = calls.slice(start, index).map((call, offset) => this.executeOneTool(call, workspace, signal, onStatus, session, turn, step, start + offset));
        const groupResults = await Promise.all(group);
        groupResults.forEach((result, offset) => { results[start + offset] = result; });
      } else {
        results[index] = await this.executeOneTool(calls[index], workspace, signal, onStatus, session, turn, step, index);
        index += 1;
      }
    }
    return results;
  }

  private async executeOneTool(call: ToolCall, workspace: string, signal: AbortSignal, onStatus: ((status: string) => void) | undefined, session: StoredSession, turn: number, step: number, _index: number): Promise<ToolResult> {
    onStatus?.(`正在执行 ${call.name}…`);
    try {
      const result = await runHubBertToolContent(call.name, call.input, workspace, signal);
      const toolResult = { content: boundedText(result.text), ...(result.image ? { image: result.image } : {}), isError: false };
      await this.appendToolResult(session, turn, step, call, toolResult);
      return toolResult;
    } catch (error) {
      if (signal.aborted) throw error;
      const toolResult = { content: normalizeError(error), isError: true };
      await this.appendToolResult(session, turn, step, call, toolResult);
      return toolResult;
    }
  }

  private async appendToolResult(session: StoredSession, turn: number, step: number, call: ToolCall, result: ToolResult): Promise<void> {
    await this.appendEvent(session, 'tool/result', { turn, step, message: { source: { kind: 'tool', callId: call.id }, content: [{ type: 'tool-result', toolCallId: call.id, content: [{ type: 'text', text: result.content }], ...(result.isError ? { isError: true } : {}) }], role: 'user', id: randomUUID() }, ...(result.isError ? { error: { name: 'ToolError', code: 'TOOL_FAILED' } } : {}) });
  }

  private async config(): Promise<{ baseUrl: string; apiKey?: string; api: string; modelId: string; models: RelayModel[]; defaultModel?: string }> {
    const dsh = await readDshRelayConfig();
    const baseUrl = (process.env.HARBORS_RELAY_BASE_URL || process.env.PI_AGENT_BASE_URL || dsh.baseUrl || '').replace(/\/$/u, '');
    const apiKey = process.env.HARBORS_RELAY_API_KEY || process.env.PI_AGENT_API_KEY || (await resolveDshCredential(dsh.apiKeyEnv))?.value;
    const modelId = process.env.HARBORS_RELAY_MODEL || process.env.PI_AGENT_MODEL || dsh.defaultModel || dsh.models[0]?.id || 'deepseek-chat';
    return { baseUrl, apiKey, api: process.env.HARBORS_RELAY_API || process.env.PI_AGENT_API || dsh.api || 'openai-completions', modelId, models: dsh.models, defaultModel: dsh.defaultModel };
  }

  private logPathFor(id: string): string { if (!/^[a-f0-9-]{36}$/iu.test(id)) throw new Error('Invalid Harbors conversation id'); return join(this.storageDir, `${id}.jsonl`); }
  private headerFor(session: StoredSession): SessionHeader { return { type: 'session', version: SESSION_FORMAT_VERSION, id: session.id, createdAt: Date.parse(session.createdAt), ...(session.project ? { cwd: session.project } : {}), ...(session.model ? { model: session.model } : {}) }; }

  private async load(id: string): Promise<StoredSession> { return this.loadByPath(this.logPathFor(id)); }

  private async loadByPath(path: string): Promise<StoredSession> {
    const raw = await readFile(path, 'utf8');
    const lines = raw.split(/\r?\n/u).filter(Boolean);
    const header = JSON.parse(lines.shift() || '') as SessionHeader;
    if (header.type !== 'session' || header.version !== SESSION_FORMAT_VERSION || !header.id) throw new Error(`Invalid Harbors session header: ${path}`);
    const events = lines.map((line) => JSON.parse(line) as AgentTraceEvent);
    const lastEvent = events.at(-1);
    return { id: header.id, title: titleFromEvents(events), ...(header.cwd ? { project: header.cwd } : {}), ...(header.model ? { model: header.model } : {}), createdAt: new Date(header.createdAt).toISOString(), updatedAt: new Date(lastEvent?.time || header.createdAt).toISOString(), messages: projectMessages(events), events, logPath: path };
  }

  private async ensureLog(session: StoredSession): Promise<void> {
    if (session.logPath) return;
    const logPath = this.logPathFor(session.id);
    await mkdir(this.storageDir, { recursive: true });
    const header = JSON.stringify(this.headerFor(session));
    const body = session.events.map((event) => JSON.stringify(event)).join('\n');
    await writeFile(logPath, `${header}\n${body}${body ? '\n' : ''}`, 'utf8');
    session.logPath = logPath;
  }

  private async appendEvent(session: StoredSession, type: string, data: Record<string, unknown>): Promise<AgentTraceEvent> {
    let result: AgentTraceEvent | undefined;
    const task = this.eventWriteQueue.then(async () => {
      await this.ensureLog(session);
      const event: AgentTraceEvent = { type, seq: session.events.length, time: Date.now(), data };
      await appendFile(session.logPath!, `${JSON.stringify(event)}\n`, 'utf8');
      session.events.push(event);
      session.messages = projectMessages(session.events);
      session.updatedAt = new Date(event.time).toISOString();
      if (type === 'session/title' && typeof data.title === 'string') session.title = data.title;
      result = event;
    });
    this.eventWriteQueue = task.then(() => undefined, () => undefined);
    await task;
    return result!;
  }
}

interface ToolCall { id: string; name: string; input: Record<string, unknown>; arguments: string; }
interface ToolResult { content: string; isError: boolean; image?: HubBertToolImage; }

function isParallelTool(name: string): boolean { return new Set(['list_files', 'read_file', 'search_text', 'list_skills', 'load_skill', 'read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch']).has(name); }
function parseToolArguments(value: string | undefined): Record<string, unknown> { if (!value) return {}; try { const parsed = JSON.parse(value) as unknown; return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
function boundedText(value: string): string { return value.length <= MAX_STORED_VALUE_CHARS ? value : `${value.slice(0, MAX_STORED_VALUE_CHARS)}\n...[truncated]`; }
function boundedJson(value: unknown): string { try { return boundedText(JSON.stringify(value)); } catch { return '[unserializable]'; } }
function normalizeError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function textContent(content: unknown): string { if (typeof content === 'string') return content; if (!Array.isArray(content)) return ''; return content.map((part) => typeof part === 'string' ? part : part && typeof part === 'object' && 'text' in part ? String((part as { text?: unknown }).text || '') : '').join(''); }
function messageContent(message: unknown): unknown { return message && typeof message === 'object' && 'content' in message ? (message as { content?: unknown }).content : ''; }
function messageSource(message: unknown): Record<string, unknown> { return message && typeof message === 'object' && 'source' in message && message.source && typeof message.source === 'object' ? message.source as Record<string, unknown> : {}; }

function projectMessages(events: AgentTraceEvent[]): AgentChatMessage[] {
  const messages: AgentChatMessage[] = [];
  for (const event of events) {
    if (event.type === 'user/message') messages.push({ id: String(event.data.id || `event-${event.seq}`), role: 'user', content: textContent(event.data.content), timestamp: new Date(event.time).toISOString() });
    else if (event.type === 'assistant/message') {
      const message = event.data.message;
      const content = textContent(messageContent(message));
      if (content) messages.push({ id: String(message && typeof message === 'object' && 'id' in message ? (message as { id?: unknown }).id : `event-${event.seq}`), role: 'assistant', content, timestamp: new Date(event.time).toISOString() });
    }
  }
  return messages;
}

function titleFromEvents(events: AgentTraceEvent[]): string { const title = events.find((event) => event.type === 'session/title' && typeof event.data.title === 'string'); if (title) return String(title.data.title); const user = events.find((event) => event.type === 'user/message'); return user ? textContent(user.data.content).trim().slice(0, 48) || '未命名对话' : '未命名对话'; }

function toOpenAiMessages(events: AgentTraceEvent[]): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  for (const event of events) {
    if (event.type === 'user/message') messages.push({ role: 'user', content: textContent(event.data.content) });
    else if (event.type === 'assistant/message') { const message = event.data.message; if (message && typeof message === 'object' && 'tool_calls' in message) messages.push({ role: 'assistant', content: (message as { content?: unknown }).content ?? null, tool_calls: (message as { tool_calls?: unknown }).tool_calls }); else messages.push({ role: 'assistant', content: textContent(messageContent(message)) }); }
    else if (event.type === 'tool/result') { const source = messageSource(event.data.message); messages.push({ role: 'tool', tool_call_id: String(source.callId || ''), content: textContent(messageContent(event.data.message)) }); }
  }
  return messages;
}

function toAnthropicMessages(events: AgentTraceEvent[]): Array<{ role: 'user' | 'assistant'; content: unknown }> {
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];
  for (const event of events) {
    if (event.type === 'user/message') messages.push({ role: 'user', content: event.data.content });
    else if (event.type === 'assistant/message') messages.push({ role: 'assistant', content: messageContent(event.data.message) });
    else if (event.type === 'tool/result') { const source = messageSource(event.data.message); messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: String(source.callId || ''), ...(event.data.error ? { is_error: true } : {}), content: textContent(messageContent(event.data.message)) }] }); }
  }
  return messages;
}

function anthropicImageBlock(image: HubBertToolImage): Record<string, unknown> { return { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } }; }
function openAiImagePart(image: HubBertToolImage): Record<string, unknown> { return { type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.base64}` } }; }
function nextTurnNumber(events: AgentTraceEvent[]): number { return events.filter((event) => event.type === 'turn/start').length + 1; }
function toConversation(session: StoredSession): AgentConversation { const last = session.messages.at(-1)?.content; return { id: session.id, title: session.title, project: session.project || 'Harbors', ...(session.model ? { model: session.model } : {}), ...(last ? { preview: last.slice(0, 120) } : {}), createdAt: session.createdAt, updatedAt: session.updatedAt }; }
