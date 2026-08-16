import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentChatMessage, AgentConversation } from './base.js';
import { readDshRelayConfig, type RelayModel } from './dsh-config.js';
import { resolveDshCredential } from './credentials.js';
import { hubbertTools, runHubBertTool } from './tools.js';

interface StoredSession { id: string; title: string; project?: string; model?: string; createdAt: string; updatedAt: string; messages: AgentChatMessage[]; }

const REQUEST_TIMEOUT_MS = 5 * 60_000;

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Harbors adapter has been stopped');
}

function requestSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
}

/** Harbors 自主管理的 agent：参考 Harness，由宿主维护 session/turn，relay 仅负责模型调用。 */
export class HarborsAdapter implements AgentAdapter {
  private stopped = false;
  private readonly abortController = new AbortController();
  private readonly storageDir = resolve(process.env.HARBORS_AGENT_STORAGE_DIR || process.env.HARBORS_PI_AGENT_STORAGE_DIR || join(homedir(), '.harbors', 'pi-agent', 'sessions'));

  async createConversation(project?: string, model?: string): Promise<AgentConversation> {
    throwIfAborted(this.abortController.signal);
    const now = new Date().toISOString();
    const session: StoredSession = { id: randomUUID(), title: '未命名对话', ...(project ? { project } : {}), ...(model ? { model } : {}), createdAt: now, updatedAt: now, messages: [] };
    await this.save(session, this.abortController.signal); return toConversation(session);
  }
  async listConversations(): Promise<AgentConversation[]> {
    await mkdir(this.storageDir, { recursive: true });
    const entries = await readdir(this.storageDir, { withFileTypes: true });
    const sessions = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => this.loadByPath(join(this.storageDir, entry.name)).catch(() => null)));
    return sessions.filter((session): session is StoredSession => session !== null).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).map(toConversation);
  }
  async deleteConversation(id: string): Promise<void> {
    throwIfAborted(this.abortController.signal);
    const trash = join(this.storageDir, '.harbors-trash', `${id}-${Date.now()}.json`);
    await mkdir(dirname(trash), { recursive: true });
    throwIfAborted(this.abortController.signal);
    await rename(this.pathFor(id), trash);
  }
  async getMessages(id: string): Promise<AgentChatMessage[]> { return (await this.load(id)).messages.map((message) => ({ ...message })); }
  async sendMessage(id: string, content: string, model?: string, _onDelta?: (delta: string) => void, onStatus?: (status: string) => void): Promise<string> {
    if (this.stopped) throw new Error('Harbors adapter has been stopped');
    const session = await this.load(id); const now = new Date().toISOString();
    if (model) session.model = model;
    session.messages.push({ id: randomUUID(), role: 'user', content, timestamp: now });
    if (session.title === '未命名对话') session.title = content.trim().slice(0, 48) || session.title;
    let response: string;
    try {
      response = await this.runTurn(session.messages, session.model, session.project, onStatus);
    } catch (error) {
      if (this.stopped) throw new Error('Harbors adapter has been stopped');
      throw error;
    }
    if (this.stopped) throw new Error('Harbors adapter has been stopped');
    const timestamp = new Date().toISOString();
    session.messages.push({ id: randomUUID(), role: 'assistant', content: response, timestamp }); session.updatedAt = timestamp;
    await this.save(session, this.abortController.signal); return response;
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
  private async runTurn(history: AgentChatMessage[], selectedModel?: string, project?: string, onStatus?: (status: string) => void): Promise<string> {
    const signal = this.abortController.signal;
    const config = await this.config();
    throwIfAborted(signal);
    const { baseUrl, apiKey, api, modelId } = config;
    if (!baseUrl) throw new Error('HubBert agent requires HARBORS_RELAY_BASE_URL or ~/.dsh/settings.yaml');
    if (!apiKey) throw new Error('HubBert agent requires HARBORS_RELAY_API_KEY or the DSH apiKeyEnv environment variable');
    const model = selectedModel || modelId;
    if (api === 'anthropic-messages') return this.runAnthropicToolLoop(baseUrl, apiKey, model, history, project, onStatus, signal);
    const { url, headers, body, readText } = {
        url: `${baseUrl}/chat/completions`, headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: { model, stream: false, messages: history.map(({ role, content }) => ({ role, content })) },
        readText: (payload: { choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }> }) => {
          const content = payload.choices?.[0]?.message?.content;
          return typeof content === 'string' ? content : content?.map((part) => part.text || '').join('');
        },
      };
    if (api !== 'openai-completions' && api !== 'anthropic-messages') throw new Error(`Unsupported Harbors relay API: ${api}`);
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: requestSignal(signal) });
    if (!response.ok) throw new Error(`Harbors relay request failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
    const text = readText(await response.json());
    if (!text) throw new Error('Harbors agent returned no text response'); return text;
  }
  private async runAnthropicToolLoop(baseUrl: string, apiKey: string, model: string, history: AgentChatMessage[], project: string | undefined, onStatus: ((status: string) => void) | undefined, signal: AbortSignal): Promise<string> {
    const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = history.map(({ role, content }) => ({ role, content }));
    const workspace = process.env.HARBORS_AGENT_WORKSPACE || project || process.cwd();
    for (let step = 0; step < 8; step += 1) {
      throwIfAborted(signal);
      onStatus?.(step ? '正在根据工具结果继续推理…' : '正在请求 HubBert…');
      const response = await fetch(`${baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 16_384, tools: hubbertTools, messages }), signal: requestSignal(signal) });
      if (!response.ok) throw new Error(`Harbors relay request failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
      const payload = await response.json() as { content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }> };
      const blocks = payload.content || [];
      const calls = blocks.filter((block) => block.type === 'tool_use' && block.id && block.name);
      if (!calls.length) {
        const text = blocks.filter((block) => block.type === 'text').map((block) => block.text || '').join('');
        if (!text) throw new Error('Harbors agent returned no text response');
        return text;
      }
      messages.push({ role: 'assistant', content: blocks });
      const results = await Promise.all(calls.map(async (call) => {
        const toolId = call.id!;
        const toolName = call.name!;
        onStatus?.(`正在执行 ${toolName}…`);
        try { return { type: 'tool_result', tool_use_id: toolId, content: await runHubBertTool(toolName, call.input || {}, workspace, signal) }; }
        catch (error) {
          if (signal.aborted) throw error;
          return { type: 'tool_result', tool_use_id: toolId, is_error: true, content: error instanceof Error ? error.message : String(error) };
        }
      }));
      messages.push({ role: 'user', content: results });
    }
    throw new Error('HubBert tool loop exceeded 8 steps');
  }
  private async config(): Promise<{ baseUrl: string; apiKey?: string; api: string; modelId: string; models: RelayModel[]; defaultModel?: string }> {
    const dsh = await readDshRelayConfig();
    const baseUrl = (process.env.HARBORS_RELAY_BASE_URL || process.env.PI_AGENT_BASE_URL || dsh.baseUrl || '').replace(/\/$/u, '');
    const apiKey = process.env.HARBORS_RELAY_API_KEY || process.env.PI_AGENT_API_KEY || (await resolveDshCredential(dsh.apiKeyEnv))?.value;
    const modelId = process.env.HARBORS_RELAY_MODEL || process.env.PI_AGENT_MODEL || dsh.defaultModel || dsh.models[0]?.id || 'deepseek-chat';
    return { baseUrl, apiKey, api: process.env.HARBORS_RELAY_API || process.env.PI_AGENT_API || dsh.api || 'openai-completions', modelId, models: dsh.models, defaultModel: dsh.defaultModel };
  }
  private pathFor(id: string): string { if (!/^[a-f0-9-]{36}$/iu.test(id)) throw new Error('Invalid Harbors conversation id'); return join(this.storageDir, `${id}.json`); }
  private async load(id: string): Promise<StoredSession> { return this.loadByPath(this.pathFor(id)); }
  private async loadByPath(path: string): Promise<StoredSession> { const parsed = JSON.parse(await readFile(path, 'utf8')) as StoredSession; if (!parsed?.id || !Array.isArray(parsed.messages)) throw new Error(`Invalid Harbors session: ${path}`); return parsed; }
  private async save(session: StoredSession, signal?: AbortSignal): Promise<void> {
    if (signal) throwIfAborted(signal);
    await mkdir(this.storageDir, { recursive: true });
    if (signal) throwIfAborted(signal);
    await writeFile(this.pathFor(session.id), JSON.stringify(session, null, 2), 'utf8');
  }
}
function toConversation(session: StoredSession): AgentConversation { const last = session.messages.at(-1)?.content; return { id: session.id, title: session.title, project: session.project || 'Harbors', ...(session.model ? { model: session.model } : {}), ...(last ? { preview: last.slice(0, 120) } : {}), createdAt: session.createdAt, updatedAt: session.updatedAt }; }
