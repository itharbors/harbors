import type { AgentAdapter, AgentChatMessage, AgentConversation, AgentSource } from './adapter/base.js';
import { CodexAdapter } from './adapter/codex.js';
import { HarborsAdapter } from './adapter/harbors.js';

declare const editor: any;

let runtime: any;
let adapters: Record<AgentSource, AgentAdapter> | null = null;

interface Conversation extends AgentConversation {
  lastMessage?: string;
  source: AgentSource;
  adapterId: string;
}

interface ChatMessage extends AgentChatMessage {
  timestamp?: string;
}

let conversations: Conversation[] = [];
let messages = new Map<string, ChatMessage[]>();
let loadedMessageIds = new Set<string>();
let pendingMessageLoads = new Map<string, Promise<ChatMessage[]>>();
let nextMsgId = 1;

function requireAdapter(source: AgentSource): AgentAdapter {
  if (!adapters) throw new Error('[agent] adapters are not initialized');
  return adapters[source];
}

function createAdapters(): Record<AgentSource, AgentAdapter> {
  return { codex: new CodexAdapter(), harbors: new HarborsAdapter() };
}

function conversationId(source: AgentSource, adapterId: string): string { return `${source}:${adapterId}`; }

function parseConversationId(id: string): { source: AgentSource; adapterId: string } {
  const delimiter = id.indexOf(':');
  const source = id.slice(0, delimiter) as AgentSource;
  const adapterId = id.slice(delimiter + 1);
  if (delimiter < 1 || !adapterId || (source !== 'codex' && source !== 'harbors')) throw new Error('[agent] invalid conversation id');
  return { source, adapterId };
}

function copyConversations(): Conversation[] {
  return conversations.map((conversation) => ({ ...conversation }));
}

async function adapterOptions(source: AgentSource) {
  if (source === 'harbors') return requireAdapter('harbors').getModels?.() || { models: [], defaultModel: '' };
  return requireAdapter('codex').getModels?.() || { models: [{ id: 'default', name: 'Codex 默认模型' }], defaultModel: 'default' };
}

function copyMessages(conversationId: string): ChatMessage[] {
  return (messages.get(conversationId) || []).map((message) => ({ ...message }));
}

async function ensureMessages(conversationId: string): Promise<ChatMessage[]> {
  if (loadedMessageIds.has(conversationId)) return messages.get(conversationId) || [];

  const pending = pendingMessageLoads.get(conversationId);
  if (pending) return pending;

  const route = parseConversationId(conversationId);
  const task = requireAdapter(route.source)
    .getMessages(route.adapterId)
    .then((result) => {
      const loaded = result.map((message) => ({ ...message }));
      messages.set(conversationId, loaded);
      loadedMessageIds.add(conversationId);
      return loaded;
    })
    .finally(() => pendingMessageLoads.delete(conversationId));

  pendingMessageLoads.set(conversationId, task);
  return task;
}

async function refreshConversations(): Promise<Conversation[]> {
  const localById = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  const results = await Promise.allSettled((['codex', 'harbors'] as const).map(async (source) => ({ source, conversations: await requireAdapter(source).listConversations() })));
  conversations = results.flatMap((result) => {
    if (result.status === 'rejected') { console.error('[agent] failed to list conversations:', result.reason); return []; }
    return result.value.conversations.map((conversation) => {
      const id = conversationId(result.value.source, conversation.id);
      const local = localById.get(id);
      return { ...conversation, ...(conversation.model || local?.model ? { model: conversation.model || local?.model } : {}), id, adapterId: conversation.id, source: result.value.source, project: conversation.project || (result.value.source === 'harbors' ? 'Harbors' : '未归类项目'), lastMessage: local?.lastMessage };
    });
  }).sort((left, right) => Date.parse(right.updatedAt || right.createdAt || '') - Date.parse(left.updatedAt || left.createdAt || ''));
  return copyConversations();
}

function broadcastConversations(): void {
  runtime?.message.broadcast('conversation.changed', copyConversations());
}

editor.plugin.define({
  lifecycle: {
    async load(ctx: any) {
      runtime = ctx;
      adapters = createAdapters();
      try {
        await refreshConversations();
        broadcastConversations();
      } catch (err) {
        console.error('[agent] failed to load conversations:', err);
      }
    },
    unload() {
      try {
        Object.values(adapters || {}).forEach((adapter) => adapter.stop());
      } catch (err) {
        console.error('[agent] failed to stop adapter:', err);
      }
      runtime = null;
      adapters = null;
      conversations = [];
      messages = new Map();
      loadedMessageIds = new Set();
      pendingMessageLoads = new Map();
      nextMsgId = 1;
    },
  },
  methods: {
    async listConversations() {
      return refreshConversations();
    },
    async getDraftOptions(source: AgentSource) {
      return adapterOptions(source);
    },
    async getConversationOptions(id: string) {
      const conversation = conversations.find((entry) => entry.id === id);
      if (!conversation) throw new Error('[agent] conversation does not exist');
      const options = await adapterOptions(conversation.source);
      return { ...options, selectedModel: conversation.model || options.defaultModel };
    },
    async createConversation(source: AgentSource = 'codex', project?: string, model?: string) {
      const result = await requireAdapter(source).createConversation(project, model);
      const conv: Conversation = { ...result, id: conversationId(source, result.id), adapterId: result.id, source };
      conversations.unshift(conv);
      messages.set(conv.id, []);
      loadedMessageIds.add(conv.id);
      broadcastConversations();
      return { ...conv };
    },
    async deleteConversation(id: string) {
      const route = parseConversationId(id);
      await requireAdapter(route.source).deleteConversation(route.adapterId);
      conversations = conversations.filter((conversation) => conversation.id !== id);
      messages.delete(id);
      loadedMessageIds.delete(id);
      pendingMessageLoads.delete(id);
      broadcastConversations();
      return id;
    },
    async getMessages(conversationId: string) {
      await ensureMessages(conversationId);
      return copyMessages(conversationId);
    },
    async sendMessage(conversationId: string, content: string, model?: string) {
      if (!conversations.some((conversation) => conversation.id === conversationId)) {
        throw new Error('[agent] conversation does not exist');
      }
      const convMessages = await ensureMessages(conversationId);
      const userMsg: ChatMessage = {
        id: `msg-${nextMsgId++}`,
        role: 'user',
        content,
        timestamp: new Date().toISOString(),
      };
      convMessages.push(userMsg);
      const aiMsg: ChatMessage = {
        id: `msg-${nextMsgId++}`,
        role: 'assistant',
        content: '',
        timestamp: new Date().toISOString(),
      };
      convMessages.push(aiMsg);
      let aiContent: string;
      try {
        const route = parseConversationId(conversationId);
        aiContent = await requireAdapter(route.source).sendMessage(route.adapterId, content, model, (delta) => {
          aiMsg.content += delta;
          runtime?.message.broadcast('message.delta', { conversationId, messageId: aiMsg.id, content: aiMsg.content });
        }, (status) => {
          runtime?.message.broadcast('message.status', { conversationId, messageId: aiMsg.id, status });
        });
      } catch (err) {
        const aiIndex = convMessages.indexOf(aiMsg);
        if (aiIndex !== -1) convMessages.splice(aiIndex, 1);
        throw err;
      }
      aiMsg.content = aiContent;
      const local = conversations.find((conversation) => conversation.id === conversationId);
      if (local) { local.lastMessage = aiContent; if (model) local.model = model; }
      try {
        await refreshConversations();
      } catch (err) {
        console.error('[agent] failed to refresh conversation metadata:', err);
      }
      broadcastConversations();
      return { ...aiMsg };
    },
  },
});
