import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEditor } from '../../../packages/server/src/editor/index';
import { createDefaultAssemblyConfig } from '../../../packages/server/src/assembly/config';
import { createTestPluginPathRoots } from '../../../packages/server/tests/helpers/plugin-paths';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const kitDirectory = path.join(projectRoot, 'kits/agent-chat');
const pluginNames = ['conversation', 'chat', 'model-service', 'agent', 'plugin', 'preview', 'debug', 'settings', 'mermaid'];

type EventRecord = { kind: 'request' | 'broadcast'; plugin?: string; name?: string; topic?: string; args: unknown[] };

function createCredentialVault() {
  const records = new Map<string, string>();
  return {
    capability: () => ({ mode: 'on', status: 'available' }),
    bind: () => ({
      capability: () => ({ mode: 'on', status: 'available' }),
      async put(input: { id?: string; secret: string }) {
        const id = input.id || 'assembly-credential';
        records.set(id, input.secret);
        return { id };
      },
      async get(id: string) {
        const secret = records.get(id);
        if (!secret) throw new Error('credential not found');
        return { profile: { id }, secret };
      },
      async delete(id: string) { records.delete(id); },
      async list() { return []; },
      async available() { return true; },
    }),
  };
}

function streamResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      frames.forEach((frame) => controller.enqueue(encoder.encode(frame)));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

function normalStream(text: string): Response {
  return streamResponse([
    `data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(0, 2) } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(2) } }] })}\n\n`,
    'data: [DONE]\n\n',
  ]);
}

function errorResponse(status = 503): Response {
  return new Response('upstream unavailable', { status, headers: { 'content-type': 'text/plain' } });
}

function pendingStream(text: string): { response: Response; close: () => void } {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(next) {
      controller = next;
      next.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
  return { response, close: () => { try { controller?.close(); } catch { /* Stop cancels the reader first. */ } } };
}

function createAssemblyEditor(sessionId: string) {
  const roots = createTestPluginPathRoots();
  const assembly = createDefaultAssemblyConfig(projectRoot, {
    kitSources: [{ directory: kitDirectory, source: 'builtin' }],
    defaultKit: 'agent-chat',
  });
  const editor = createEditor(sessionId, {
    assembly,
    pluginPathRoots: roots,
    configStorageRoots: { 'application-data': roots.applicationData },
    credentialVault: createCredentialVault(),
  });
  return { editor, roots };
}

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeout = 4_000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out after ${timeout}ms`);
}

describe('Agent Chat Kit real assembly', () => {
  const originalFetch = globalThis.fetch;
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    while (cleanups.length) await cleanups.pop()!();
  });

  it('loads every declared plugin and preserves the request/broadcast chain for a streamed turn', async () => {
    const { editor, roots } = createAssemblyEditor('assembly-normal');
    cleanups.push(() => { fs.rmSync(roots.applicationData, { recursive: true, force: true }); });
    await editor.kit.load();

    expect(editor.plugin.listLoaded()).toEqual(expect.arrayContaining(['panel', 'message', 'menu', 'config', ...pluginNames]));
    for (const plugin of pluginNames) expect(editor.plugin.getInfo(plugin)?.source.scope).toBe('kit');
    expect(editor.kit.getCurrent()?.name).toBe('agent-chat');
    expect(editor.panel.getInfo('chat.main')).toBeDefined();
    expect(editor.panel.getInfo('conversation.list')).toBeDefined();

    for (const [plugin, name] of [
      ['agent', 'createConversation'], ['agent', 'sendMessage'], ['agent', 'getConversationTrace'],
      ['model-service', 'getCatalog'], ['model-service', 'complete'], ['conversation', 'getState'],
    ] as const) expect(editor.message.queryRequest(plugin, name)).toBeDefined();
    expect(editor.message.queryBroadcast('model-service.complete.delta').map((route) => route.plugin)).toContain('agent');
    expect(editor.message.queryBroadcast('agent.conversation.trace.append').map((route) => route.plugin)).toContain('chat');

    const events: EventRecord[] = [];
    const realRequest = editor.message.request.bind(editor.message);
    vi.spyOn(editor.message, 'request').mockImplementation(async (plugin: string, name: string, ...args: unknown[]) => {
      events.push({ kind: 'request', plugin, name, args });
      return realRequest(plugin, name, ...args);
    });
    const realRequestFrom = editor.message.requestFrom!.bind(editor.message);
    vi.spyOn(editor.message, 'requestFrom').mockImplementation(async (caller: string, plugin: string, name: string, ...args: unknown[]) => {
      events.push({ kind: 'request', plugin, name, args });
      return realRequestFrom(caller, plugin, name, ...args);
    });
    const realBroadcast = editor.message.broadcast.bind(editor.message);
    vi.spyOn(editor.message, 'broadcast').mockImplementation((topic: string, ...args: unknown[]) => {
      events.push({ kind: 'broadcast', topic, args });
      realBroadcast(topic, ...args);
    });

    globalThis.fetch = vi.fn(async () => normalStream('装配通过')) as typeof fetch;
    await editor.message.requestFrom!('model-service', 'model-service', 'saveProvider', {
      id: 'assembly-provider', name: 'Assembly Provider', baseUrl: 'https://assembly.invalid',
      secret: 'assembly-secret', models: [{ id: 'assembly-model', streaming: true }], defaultModel: 'assembly-model',
    });
    const conversation = await editor.message.request('agent', 'createConversation', 'harbors', projectRoot, {
      model: 'assembly-model', sandboxMode: 'workspace-write', approvalPolicy: 'ask',
    }) as { id: string };
    const result = await editor.message.request('agent', 'sendMessage', conversation.id, '请回复装配通过', { model: 'assembly-model' }) as { content: string };

    expect(result.content).toBe('装配通过');
    expect(events.some((event) => event.kind === 'request' && event.plugin === 'model-service' && event.name === 'complete')).toBe(true);
    const topics = events.filter((event) => event.kind === 'broadcast').map((event) => event.topic);
    expect(topics).toContain('model-service.complete.delta');
    expect(topics).toContain('agent.conversation.trace.append');
    expect(topics).toContain('agent.message.delta');
    expect(topics).toContain('agent.message.status');
    const trace = await editor.message.request('agent', 'getConversationTrace', conversation.id) as Array<Record<string, any>>;
    expect(trace.at(-1)?.type).toBe('turn/end');
    expect(trace.at(-1)?.data.reason.kind).toBe('completed');
    expect(trace.map((event) => event.seq)).toEqual([...trace].map((event) => event.seq).sort((a, b) => a - b));
    expect(trace.filter((event) => event.type === 'item/started').length).toBeGreaterThan(0);
    expect(trace.some((event) => event.type === 'item/completed' && event.data.item?.phase === 'completed')).toBe(true);
    await editor.dispose();
  });

  it('routes approval asked/resolved through the real Agent and persists a rejected tool result', async () => {
    const { editor, roots } = createAssemblyEditor('assembly-approval');
    cleanups.push(() => { fs.rmSync(roots.applicationData, { recursive: true, force: true }); });
    await editor.kit.load();
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) return normalToolCall();
      return normalStream('不应继续');
    }) as typeof fetch;
    await editor.message.requestFrom!('model-service', 'model-service', 'saveProvider', {
      id: 'approval-provider', name: 'Approval Provider', baseUrl: 'https://approval.invalid',
      secret: 'approval-secret', models: [{ id: 'approval-model', streaming: true }], defaultModel: 'approval-model',
    });
    const conversation = await editor.message.request('agent', 'createConversation', 'harbors', projectRoot, {
      model: 'approval-model', sandboxMode: 'read-only', approvalPolicy: 'ask',
    }) as { id: string };
    const pending = editor.message.request('agent', 'sendMessage', conversation.id, '请写文件', { model: 'approval-model' });
    const request = await waitFor(() => editor.message.request('agent', 'getPendingPermissionRequests', conversation.id) as Promise<Array<Record<string, string>>>, (value) => value.length > 0);
    expect(request[0]).toMatchObject({ conversationId: conversation.id, toolName: 'write', requestedMode: 'workspace-write' });
    const resolved = await editor.message.request('agent', 'resolvePermissionRequest', { requestId: request[0].requestId, outcome: 'rejected' });
    expect(resolved).toBe(true);
    await expect(pending).resolves.toMatchObject({ role: 'assistant' });
    const trace = await editor.message.request('agent', 'getConversationTrace', conversation.id) as Array<Record<string, any>>;
    const asked = trace.find((event) => event.type === 'approval/asked');
    const resolvedEvent = trace.find((event) => event.type === 'approval/resolved');
    expect(asked?.data.requestId).toBe(request[0].requestId);
    expect(resolvedEvent?.data.outcome).toBe('rejected');
    expect(trace.some((event) => event.type === 'tool/result' && event.data.error?.code === 'TOOL_FAILED')).toBe(true);
    // A rejected tool call is recorded as an error result; the Agent can still
    // ask the model for a recovery response, so this turn completes normally.
    expect(trace.at(-1)?.data.reason.kind).toBe('completed');
    await editor.dispose();
  });

  it('restores conversation history after the Agent plugin is restarted and rejects late old-generation traffic', async () => {
    const { editor, roots } = createAssemblyEditor('assembly-restart');
    cleanups.push(() => { fs.rmSync(roots.applicationData, { recursive: true, force: true }); });
    await editor.kit.load();
    globalThis.fetch = vi.fn(async () => normalStream('重启前')) as typeof fetch;
    await editor.message.requestFrom!('model-service', 'model-service', 'saveProvider', {
      id: 'restart-provider', name: 'Restart Provider', baseUrl: 'https://restart.invalid',
      secret: 'restart-secret', models: [{ id: 'restart-model', streaming: true }], defaultModel: 'restart-model',
    });
    const conversation = await editor.message.request('agent', 'createConversation', 'harbors', projectRoot, { model: 'restart-model' }) as { id: string };
    await editor.message.request('agent', 'sendMessage', conversation.id, '重启前消息', { model: 'restart-model' });
    const before = await editor.message.request('agent', 'getConversationTrace', conversation.id) as Array<Record<string, any>>;
    const agentPath = editor.plugin.getInfo('agent')?.path;
    expect(agentPath).toBeTruthy();
    await editor.plugin.unload(agentPath!);
    expect(editor.message.queryRequest('agent', 'sendMessage')).toBeUndefined();
    await editor.plugin.load(agentPath!);
    expect(editor.message.queryRequest('agent', 'sendMessage')).toBeDefined();
    const after = await editor.message.request('agent', 'getConversationTrace', conversation.id) as Array<Record<string, any>>;
    expect(after.length).toBe(before.length);
    expect(after.at(-1)?.data.reason.kind).toBe('completed');
    const late = { requestId: 'old-request', generation: 'old-generation', sequence: 99, delta: { type: 'text', text: 'late' } };
    editor.message.broadcast('model-service.complete.delta', late);
    expect(await editor.message.request('agent', 'getConversationTrace', conversation.id)).toEqual(after);
    await editor.dispose();
  });

  it('propagates Stop through Agent to Model Service cancel and persists cancelled turn terminal state', async () => {
    const { editor, roots } = createAssemblyEditor('assembly-stop');
    cleanups.push(() => { fs.rmSync(roots.applicationData, { recursive: true, force: true }); });
    await editor.kit.load();
    const pending = pendingStream('仍在生成');
    const fetchMock = vi.fn(async () => pending.response);
    globalThis.fetch = fetchMock as typeof fetch;
    const requests: Array<{ caller: string; plugin: string; name: string; args: unknown[] }> = [];
    const realRequestFrom = editor.message.requestFrom!.bind(editor.message);
    vi.spyOn(editor.message, 'requestFrom').mockImplementation(async (caller: string, plugin: string, name: string, ...args: unknown[]) => {
      requests.push({ caller, plugin, name, args });
      return realRequestFrom(caller, plugin, name, ...args);
    });
    await editor.message.requestFrom!('model-service', 'model-service', 'saveProvider', {
      id: 'stop-provider', name: 'Stop Provider', baseUrl: 'https://stop.invalid', secret: 'stop-secret',
      models: [{ id: 'stop-model', streaming: true }], defaultModel: 'stop-model',
    });
    const conversation = await editor.message.request('agent', 'createConversation', 'harbors', projectRoot, { model: 'stop-model' }) as { id: string };
    const sending = editor.message.request('agent', 'sendMessage', conversation.id, '请保持生成', { model: 'stop-model' });
    await waitFor(async () => fetchMock.mock.calls.length, (value) => value > 0);
    expect(await editor.message.request('agent', 'stopConversation', conversation.id)).toBe(true);
    await expect(sending).rejects.toMatchObject({ code: 'MODEL_SERVICE_CANCELLED' });
    expect(requests.some((request) => request.caller === 'agent' && request.plugin === 'model-service' && request.name === 'cancel')).toBe(true);
    const trace = await editor.message.request('agent', 'getConversationTrace', conversation.id) as Array<Record<string, any>>;
    expect(trace.at(-1)?.type).toBe('turn/end');
    expect(trace.at(-1)?.data.reason.kind).toBe('cancelled');
    pending.close();
    await editor.dispose();
  });

  it('records Model Service upstream errors as correlated failed turn terminal state', async () => {
    const { editor, roots } = createAssemblyEditor('assembly-error');
    cleanups.push(() => { fs.rmSync(roots.applicationData, { recursive: true, force: true }); });
    await editor.kit.load();
    globalThis.fetch = vi.fn(async () => errorResponse()) as typeof fetch;
    await editor.message.requestFrom!('model-service', 'model-service', 'saveProvider', {
      id: 'error-provider', name: 'Error Provider', baseUrl: 'https://error.invalid', secret: 'error-secret',
      models: [{ id: 'error-model', streaming: true }], defaultModel: 'error-model',
      options: { retryEnabled: false },
    });
    const conversation = await editor.message.request('agent', 'createConversation', 'harbors', projectRoot, { model: 'error-model' }) as { id: string };
    await expect(editor.message.request('agent', 'sendMessage', conversation.id, '触发上游错误', { model: 'error-model' }))
      .rejects.toMatchObject({ code: 'MODEL_SERVICE_HTTP_ERROR', requestId: expect.any(String) });
    const trace = await editor.message.request('agent', 'getConversationTrace', conversation.id) as Array<Record<string, any>>;
    const terminal = trace.at(-1);
    expect(terminal?.type).toBe('turn/end');
    expect(terminal?.data.reason.kind).toBe('failed');
    expect(terminal?.data.reason.error).toMatchObject({ code: 'MODEL_SERVICE_HTTP_ERROR', requestId: expect.any(String) });
    await editor.dispose();
  });

  it('switches selected conversation and ignores repeated late delta from the previous generation', async () => {
    const { editor, roots } = createAssemblyEditor('assembly-switch');
    cleanups.push(() => { fs.rmSync(roots.applicationData, { recursive: true, force: true }); });
    await editor.kit.load();
    globalThis.fetch = vi.fn(async () => normalStream('会话完成')) as typeof fetch;
    await editor.message.requestFrom!('model-service', 'model-service', 'saveProvider', {
      id: 'switch-provider', name: 'Switch Provider', baseUrl: 'https://switch.invalid', secret: 'switch-secret',
      models: [{ id: 'switch-model', streaming: true }], defaultModel: 'switch-model',
    });
    const first = await editor.message.request('agent', 'createConversation', 'harbors', projectRoot, { model: 'switch-model' }) as { id: string };
    const second = await editor.message.request('agent', 'createConversation', 'harbors', projectRoot, { model: 'switch-model' }) as { id: string };
    await editor.message.request('agent', 'sendMessage', first.id, '第一会话', { model: 'switch-model' });
    await editor.message.request('agent', 'sendMessage', second.id, '第二会话', { model: 'switch-model' });
    const selected = await editor.message.request('conversation', 'select', first.id) as Record<string, any>;
    expect(selected.selectedConversationId).toBe(first.id);
    const before = await editor.message.request('agent', 'getConversationTrace', second.id) as Array<Record<string, any>>;
    const stale = { requestId: 'late-switch-request', generation: 'late-switch-generation', sequence: 10, delta: { type: 'text', text: '旧会话晚到内容' } };
    editor.message.broadcast('model-service.complete.delta', stale);
    editor.message.broadcast('model-service.complete.delta', stale);
    const after = await editor.message.request('agent', 'getConversationTrace', second.id) as Array<Record<string, any>>;
    expect(after).toEqual(before);
    expect(after.every((event) => !JSON.stringify(event).includes('旧会话晚到内容'))).toBe(true);
    await editor.dispose();
  });
});

function normalToolCall(): Response {
  return streamResponse([
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-write', function: { name: 'write', arguments: '{"file_path":"approval.txt","content":"no"}' } }] } }] })}\n\n`,
    'data: [DONE]\n\n',
  ]);
}
