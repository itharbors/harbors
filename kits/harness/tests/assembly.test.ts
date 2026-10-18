import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKitAssemblyHarness, type KitAssemblyHarness } from '@itharbors/server/testing';

const kitDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(kitDirectory, '../..');
const pluginNames = ['conversation', 'chat', 'model-service', 'agent-context-store', 'agent', 'plugin', 'preview', 'debug', 'settings', 'mermaid'];
const layout = JSON.parse(fs.readFileSync(path.join(kitDirectory, 'layout.json'), 'utf8')) as { windows?: Array<{ id?: string }> };

function createCredentialVault() {
  const records = new Map<string, string>();
  return {
    capability: () => ({ mode: 'on' as const, status: 'available' as const }),
    bind: () => ({
      async capability() { return { mode: 'on' as const, status: 'available' as const }; },
      async put(input: { id?: string; label: string; metadata: Record<string, string | number | boolean | null>; secret: string }) {
        const id = input.id || 'assembly-credential';
        records.set(id, input.secret);
        const now = new Date(0).toISOString();
        return { id, label: input.label, metadata: input.metadata, createdAt: now, updatedAt: now };
      },
      async get(id: string) {
        const secret = records.get(id);
        if (!secret) throw new Error('credential not found');
        const now = new Date(0).toISOString();
        return { profile: { id, label: id, metadata: {}, createdAt: now, updatedAt: now }, secret };
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

function createAssembly(sessionId: string, applicationData?: string, userId = 'assembly-user'): KitAssemblyHarness {
  return createKitAssemblyHarness({
    projectRoot,
    kitDirectory,
    kitName: 'harness',
    sessionId,
    identity: { userId, sessionId },
    ...(applicationData ? { paths: { applicationData } } : {}),
    credentials: createCredentialVault(),
  });
}

function snapshotTree(root: string): Array<{ path: string; bytes: string; mtimeMs: number }> {
  if (!fs.existsSync(root)) return [];
  const result: Array<{ path: string; bytes: string; mtimeMs: number }> = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) { const stat = fs.statSync(absolute); result.push({ path: path.relative(root, absolute), bytes: fs.readFileSync(absolute).toString('base64'), mtimeMs: stat.mtimeMs }); }
      else { const stat = fs.lstatSync(absolute); result.push({ path: path.relative(root, absolute), bytes: `special:${stat.mode}`, mtimeMs: stat.mtimeMs }); }
    }
  };
  visit(root); return result.sort((a, b) => a.path.localeCompare(b.path));
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

describe('Harbors Harness Kit real assembly', () => {
  const originalFetch = globalThis.fetch;
  const harnesses: KitAssemblyHarness[] = [];
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    while (harnesses.length) await harnesses.pop()!.dispose();
    while (temporaryDirectories.length) fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  });

  function harness(sessionId: string): KitAssemblyHarness {
    const value = createAssembly(sessionId);
    harnesses.push(value);
    return value;
  }

  it('shares persisted history and settings across one user sessions while isolating another user', async () => {
    const applicationData = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-user-scope-'));
    temporaryDirectories.push(applicationData);
    const first = createAssembly('user-a-first', applicationData, 'user-a');
    harnesses.push(first);
    await first.kit.load();
    await first.messages.requestFrom('model-service', 'model-service', 'saveProvider', {
      id: 'private-provider', name: 'User A Provider', baseUrl: 'https://user-a.invalid',
      secret: 'fixture-user-a', models: [{ id: 'private-model' }], defaultModel: 'private-model',
    });
    await first.messages.requestFrom('agent', 'agent', 'saveSettings', {
      sandboxMode: 'read-only', approvalPolicy: 'ask', customInstructions: 'User A private instructions',
    });
    const conversation = await first.messages.request('agent', 'createConversation', 'harbors', projectRoot, {
      model: 'private-model',
    }) as { id: string };

    const otherUser = createAssembly('user-b-first', applicationData, 'user-b');
    harnesses.push(otherUser);
    await otherUser.kit.load();
    expect(await otherUser.messages.request('agent', 'listConversations')).toEqual([]);
    const otherSettings = await otherUser.messages.requestFrom('agent', 'agent', 'getSettings') as { customInstructions: string };
    expect(otherSettings.customInstructions).toBe('');
    const otherProviders = await otherUser.messages.requestFrom('model-service', 'model-service', 'getSettings') as { providers: unknown[] };
    expect(otherProviders.providers).toEqual([]);
    await expect(otherUser.messages.request('agent', 'getConversationTrace', conversation.id)).rejects.toThrow();

    const sameUser = createAssembly('user-a-second', applicationData, 'user-a');
    harnesses.push(sameUser);
    await sameUser.kit.load();
    expect(await sameUser.messages.request('agent', 'listConversations')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: conversation.id }),
    ]));
    const sameSettings = await sameUser.messages.requestFrom('agent', 'agent', 'getSettings') as { customInstructions: string };
    expect(sameSettings.customInstructions).toBe('User A private instructions');
    const sameProviders = await sameUser.messages.requestFrom('model-service', 'model-service', 'getSettings') as { providers: Array<{ id: string }> };
    expect(sameProviders.providers).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'private-provider' })]));
    expect(await sameUser.messages.request('agent', 'getConversationTrace', conversation.id)).toEqual(
      await first.messages.request('agent', 'getConversationTrace', conversation.id),
    );
  });

  it('loads every declared plugin and preserves the request/broadcast chain for a streamed turn', async () => {
    const runtime = harness('assembly-normal');
    await runtime.kit.load();

    expect(runtime.plugin.loaded()).toEqual(expect.arrayContaining(['panel', 'message', 'menu', 'config', ...pluginNames]));
    for (const plugin of pluginNames) expect(runtime.plugin.info(plugin)?.source.scope).toBe('kit');
    expect(runtime.kit.current()?.name).toBe('harness');
    expect(runtime.kit.current()?.menuRoot).toEqual({ id: 'harness', label: 'Harbors Harness' });
    expect(layout.windows?.map((window) => window.id)).toEqual(['harness-main']);
    expect(runtime.plugin.info('chat')?.contribute?.panel?.main).toBeDefined();
    expect(runtime.plugin.info('conversation')?.contribute?.panel?.list).toBeDefined();
    expect(runtime.plugin.info('settings')?.contribute?.menu).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'view/panels/ce-settings-settings',
        message: 'openSettingsPanel',
      }),
    ]));
    expect(runtime.messages.queryRequest('settings', 'openSettingsPanel')).toMatchObject({
      plugin: 'settings',
      name: 'openSettingsPanel',
      methods: ['openSettingsPanel'],
      location: 'server',
    });
    await expect(runtime.messages.request('settings', 'openSettingsPanel')).resolves.toMatchObject({
      panelName: 'settings.settings',
    });

    for (const [plugin, name] of [
      ['agent', 'createConversation'], ['agent', 'sendMessage'], ['agent', 'getConversationTrace'],
      ['model-service', 'getCatalog'], ['model-service', 'complete'], ['conversation', 'getState'],
    ] as const) expect(runtime.messages.queryRequest(plugin, name)).toBeDefined();
    expect(runtime.messages.queryBroadcast('model-service.complete.delta').map((route) => route.plugin)).toContain('agent');
    expect(runtime.messages.queryBroadcast('agent.conversation.trace.append').map((route) => route.plugin)).toContain('chat');

    globalThis.fetch = vi.fn(async () => normalStream('装配通过')) as typeof fetch;
    await runtime.messages.requestFrom('model-service', 'model-service', 'saveProvider', {
      id: 'assembly-provider', name: 'Assembly Provider', baseUrl: 'https://assembly.invalid',
      secret: 'assembly-secret', models: [{ id: 'assembly-model', streaming: true }], defaultModel: 'assembly-model',
    });
    const conversation = await runtime.messages.request('agent', 'createConversation', 'harbors', projectRoot, {
      model: 'assembly-model', sandboxMode: 'workspace-write', approvalPolicy: 'ask',
    }) as { id: string };
    const result = await runtime.messages.request('agent', 'sendMessage', conversation.id, '请回复装配通过', { model: 'assembly-model' }) as { content: string };

    expect(result.content).toBe('装配通过');
    expect(runtime.observer.events.some((event) => event.kind === 'request' && event.plugin === 'model-service' && event.name === 'complete')).toBe(true);
    const topics = await waitFor(
      async () => runtime.observer.events.filter((event) => event.kind === 'broadcast').map((event) => event.topic),
      (value) => value.includes('agent.message.status'),
    );
    expect(topics).toContain('model-service.complete.delta');
    expect(topics).toContain('agent.conversation.trace.append');
    expect(topics).toContain('agent.message.delta');
    expect(topics).toContain('agent.message.status');
    const trace = await runtime.messages.request('agent', 'getConversationTrace', conversation.id) as Array<Record<string, any>>;
    expect(trace.at(-1)?.type).toBe('turn/end');
    expect(trace.at(-1)?.data.reason.kind).toBe('completed');
    expect(trace.map((event) => event.seq)).toEqual([...trace].map((event) => event.seq).sort((a, b) => a - b));
    expect(trace.filter((event) => event.type === 'item/started').length).toBeGreaterThan(0);
    expect(trace.some((event) => event.type === 'item/completed' && event.data.item?.phase === 'completed')).toBe(true);
    const context = trace.find((event) => event.type === 'request/context')!;
    expect(context.data.builderVersion).toBe('candidate-v1');
    expect(context.data.planId).toEqual(expect.any(String));
    expect(context.data.shadowBuilderVersion).toBeUndefined();
    expect(context.data.shadowPlanId).toBeUndefined();
  });

  it('routes approval asked/resolved through the real Agent and persists a rejected tool result', async () => {
    const runtime = harness('assembly-approval');
    await runtime.kit.load();
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => ++callCount === 1 ? normalToolCall() : normalStream('不应继续')) as typeof fetch;
    await runtime.messages.requestFrom('model-service', 'model-service', 'saveProvider', {
      id: 'approval-provider', name: 'Approval Provider', baseUrl: 'https://approval.invalid',
      secret: 'approval-secret', models: [{ id: 'approval-model', streaming: true }], defaultModel: 'approval-model',
    });
    const conversation = await runtime.messages.request('agent', 'createConversation', 'harbors', projectRoot, {
      model: 'approval-model', sandboxMode: 'read-only', approvalPolicy: 'ask',
    }) as { id: string };
    const pending = runtime.messages.request('agent', 'sendMessage', conversation.id, '请写文件', { model: 'approval-model' });
    const request = await waitFor(
      () => runtime.messages.request('agent', 'getPendingPermissionRequests', conversation.id) as Promise<Array<Record<string, string>>>,
      (value) => value.length > 0,
    );
    expect(request[0]).toMatchObject({ conversationId: conversation.id, toolName: 'write', requestedMode: 'workspace-write' });
    expect(await runtime.messages.request('agent', 'resolvePermissionRequest', { requestId: request[0].requestId, outcome: 'rejected' })).toBe(true);
    await expect(pending).resolves.toMatchObject({ role: 'assistant' });
    const trace = await runtime.messages.request('agent', 'getConversationTrace', conversation.id) as Array<Record<string, any>>;
    expect(trace.find((event) => event.type === 'approval/asked')?.data.requestId).toBe(request[0].requestId);
    expect(trace.find((event) => event.type === 'approval/resolved')?.data.outcome).toBe('rejected');
    expect(trace.some((event) => event.type === 'tool/result' && event.data.error?.code === 'TOOL_FAILED')).toBe(true);
    expect(trace.at(-1)?.data.reason.kind).toBe('completed');
  });

  it('restores conversation history after the Kit assembly is restarted and rejects late old-generation traffic', async () => {
    const applicationData = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-assembly-restart-'));
    temporaryDirectories.push(applicationData);
    const runtime = createAssembly('assembly-restart', applicationData);
    harnesses.push(runtime);
    await runtime.kit.load();
    globalThis.fetch = vi.fn(async () => normalStream('重启前')) as typeof fetch;
    await runtime.messages.requestFrom('model-service', 'model-service', 'saveProvider', {
      id: 'restart-provider', name: 'Restart Provider', baseUrl: 'https://restart.invalid',
      secret: 'restart-secret', models: [{ id: 'restart-model', streaming: true }], defaultModel: 'restart-model',
    });
    const conversation = await runtime.messages.request('agent', 'createConversation', 'harbors', projectRoot, { model: 'restart-model' }) as { id: string };
    await runtime.messages.request('agent', 'sendMessage', conversation.id, '重启前消息', { model: 'restart-model' });
    const before = await runtime.messages.request('agent', 'getConversationTrace', conversation.id) as Array<Record<string, any>>;
    await runtime.dispose();

    const restarted = createAssembly('assembly-restart', applicationData);
    harnesses.push(restarted);
    await restarted.kit.load();
    expect(restarted.messages.queryRequest('agent', 'sendMessage')).toBeDefined();
    const after = await restarted.messages.request('agent', 'getConversationTrace', conversation.id) as Array<Record<string, any>>;
    expect(after.length).toBe(before.length);
    expect(after.at(-1)?.data.reason.kind).toBe('completed');
    restarted.messages.broadcast('model-service.complete.delta', {
      requestId: 'old-request', generation: 'old-generation', sequence: 99, delta: { type: 'text', text: 'late' },
    });
    expect(await restarted.messages.request('agent', 'getConversationTrace', conversation.id)).toEqual(after);
  });

  it('propagates Stop through Agent to Model Service cancel and persists cancelled turn terminal state', async () => {
    const runtime = harness('assembly-stop');
    await runtime.kit.load();
    const pending = pendingStream('仍在生成');
    const fetchMock = vi.fn(async () => pending.response);
    globalThis.fetch = fetchMock as typeof fetch;
    await runtime.messages.requestFrom('model-service', 'model-service', 'saveProvider', {
      id: 'stop-provider', name: 'Stop Provider', baseUrl: 'https://stop.invalid', secret: 'stop-secret',
      models: [{ id: 'stop-model', streaming: true }], defaultModel: 'stop-model',
    });
    const conversation = await runtime.messages.request('agent', 'createConversation', 'harbors', projectRoot, { model: 'stop-model' }) as { id: string };
    const sending = runtime.messages.request('agent', 'sendMessage', conversation.id, '请保持生成', { model: 'stop-model' });
    await waitFor(async () => fetchMock.mock.calls.length, (value) => value > 0);
    expect(await runtime.messages.request('agent', 'stopConversation', conversation.id)).toBe(true);
    await expect(sending).rejects.toMatchObject({ code: 'MODEL_SERVICE_CANCELLED' });
    expect(runtime.observer.events.some((event) => event.kind === 'request'
      && event.caller === 'agent' && event.plugin === 'model-service' && event.name === 'cancel')).toBe(true);
    const trace = await runtime.messages.request('agent', 'getConversationTrace', conversation.id) as Array<Record<string, any>>;
    expect(trace.at(-1)?.type).toBe('turn/end');
    expect(trace.at(-1)?.data.reason.kind).toBe('cancelled');
    pending.close();
  });

  it('records Model Service upstream errors as correlated failed turn terminal state', async () => {
    const runtime = harness('assembly-error');
    await runtime.kit.load();
    globalThis.fetch = vi.fn(async () => errorResponse()) as typeof fetch;
    await runtime.messages.requestFrom('model-service', 'model-service', 'saveProvider', {
      id: 'error-provider', name: 'Error Provider', baseUrl: 'https://error.invalid', secret: 'error-secret',
      models: [{ id: 'error-model', streaming: true }], defaultModel: 'error-model', options: { retryEnabled: false },
    });
    const conversation = await runtime.messages.request('agent', 'createConversation', 'harbors', projectRoot, { model: 'error-model' }) as { id: string };
    await expect(runtime.messages.request('agent', 'sendMessage', conversation.id, '触发上游错误', { model: 'error-model' }))
      .rejects.toMatchObject({ code: 'MODEL_SERVICE_HTTP_ERROR', requestId: expect.any(String) });
    const trace = await runtime.messages.request('agent', 'getConversationTrace', conversation.id) as Array<Record<string, any>>;
    expect(trace.at(-1)?.type).toBe('turn/end');
    expect(trace.at(-1)?.data.reason.kind).toBe('failed');
    expect(trace.at(-1)?.data.reason.error).toMatchObject({ code: 'MODEL_SERVICE_HTTP_ERROR', requestId: expect.any(String) });
  });

  it('switches selected conversation and ignores repeated late delta from the previous generation', async () => {
    const runtime = harness('assembly-switch');
    await runtime.kit.load();
    globalThis.fetch = vi.fn(async () => normalStream('会话完成')) as typeof fetch;
    await runtime.messages.requestFrom('model-service', 'model-service', 'saveProvider', {
      id: 'switch-provider', name: 'Switch Provider', baseUrl: 'https://switch.invalid', secret: 'switch-secret',
      models: [{ id: 'switch-model', streaming: true }], defaultModel: 'switch-model',
    });
    const first = await runtime.messages.request('agent', 'createConversation', 'harbors', projectRoot, { model: 'switch-model' }) as { id: string };
    const second = await runtime.messages.request('agent', 'createConversation', 'harbors', projectRoot, { model: 'switch-model' }) as { id: string };
    await runtime.messages.request('agent', 'sendMessage', first.id, '第一会话', { model: 'switch-model' });
    await runtime.messages.request('agent', 'sendMessage', second.id, '第二会话', { model: 'switch-model' });
    const selected = await runtime.messages.request('conversation', 'select', first.id) as Record<string, any>;
    expect(selected.selectedConversationId).toBe(first.id);
    const before = await runtime.messages.request('agent', 'getConversationTrace', second.id) as Array<Record<string, any>>;
    const stale = { requestId: 'late-switch-request', generation: 'late-switch-generation', sequence: 10, delta: { type: 'text', text: '旧会话晚到内容' } };
    runtime.messages.broadcast('model-service.complete.delta', stale);
    runtime.messages.broadcast('model-service.complete.delta', stale);
    const after = await runtime.messages.request('agent', 'getConversationTrace', second.id) as Array<Record<string, any>>;
    expect(after).toEqual(before);
    expect(after.every((event) => !JSON.stringify(event).includes('旧会话晚到内容'))).toBe(true);
  });

  it('archives through Conversation, restores the original trace, and keeps restore selection stable', async () => {
    const runtime = harness('assembly-archive');
    await runtime.kit.load();
    const first = await runtime.messages.request('agent', 'createConversation', 'harbors', projectRoot) as { id: string };
    const second = await runtime.messages.request('agent', 'createConversation', 'harbors', projectRoot) as { id: string };
    await runtime.messages.request('conversation', 'select', first.id);
    const traceBefore = await runtime.messages.request('agent', 'getConversationTrace', first.id);
    const archived = await runtime.messages.requestFrom('conversation', 'conversation', 'archiveConversation', first.id) as any;
    expect(archived).toMatchObject({ ok: true, value: { id: first.id, source: 'harbors', status: 'available' } });
    expect(await runtime.messages.request('conversation', 'getState')).toMatchObject({ selectedConversationId: second.id });
    const list = await runtime.messages.requestFrom('conversation', 'conversation', 'listArchivedConversations') as any;
    expect(list).toMatchObject({ ok: true, value: [expect.objectContaining({ id: first.id })] });
    const restored = await runtime.messages.requestFrom('conversation', 'conversation', 'restoreConversation', first.id) as any;
    expect(restored).toMatchObject({ ok: true, value: { id: first.id } });
    expect(await runtime.messages.request('conversation', 'getState')).toMatchObject({ selectedConversationId: second.id });
    const restoredTrace = await runtime.messages.request('agent', 'getConversationTrace', first.id) as Array<Record<string, any>>;
    expect(restoredTrace.slice(0, (traceBefore as Array<unknown>).length)).toEqual(traceBefore);
    expect(restoredTrace.slice(-2).map((event) => event.type)).toEqual(['conversation/archive', 'conversation/restore']);
    expect(await runtime.messages.requestFrom('conversation', 'conversation', 'archiveConversation', first.id)).toMatchObject({ ok: true, value: { id: first.id } });
    expect(await runtime.messages.requestFrom('conversation', 'conversation', 'deleteArchivedConversation', first.id)).toEqual({ ok: true, value: { id: first.id } });
    expect(await runtime.messages.requestFrom('conversation', 'conversation', 'listArchivedConversations')).toEqual({ ok: true, value: [] });
    const events = runtime.observer.events;
    const archiveRequest = events.find((event) => event.kind === 'request' && event.caller === 'conversation' && event.plugin === 'agent' && event.name === 'archiveConversation');
    const archiveBroadcast = events.find((event) => event.kind === 'broadcast' && event.topic === 'agent.conversation.changed' && (event.args[0] as any)?.action === 'archive');
    const deleteRequest = events.find((event) => event.kind === 'request' && event.caller === 'conversation' && event.plugin === 'agent' && event.name === 'deleteArchivedConversation');
    const deleteBroadcast = events.find((event) => event.kind === 'broadcast' && event.topic === 'agent.conversation.changed' && (event.args[0] as any)?.action === 'delete');
    expect(archiveRequest).toBeDefined(); expect(archiveBroadcast).toBeDefined();
    expect(archiveRequest!.sequence).toBeLessThan(archiveBroadcast!.sequence);
    expect(deleteRequest).toBeDefined(); expect(deleteBroadcast).toBeDefined();
    expect(deleteRequest!.sequence).toBeLessThan(deleteBroadcast!.sequence);
  });

  it('rejects an active archive without side effects and persists archive/restore across assembly restart', async () => {
    const applicationData = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-assembly-archive-restart-'));
    temporaryDirectories.push(applicationData);
    const runtime = createAssembly('assembly-archive-restart', applicationData); harnesses.push(runtime);
    await runtime.kit.load();
    const pending = pendingStream('仍在运行');
    const fetchMock = vi.fn(async () => pending.response); globalThis.fetch = fetchMock as typeof fetch;
    await runtime.messages.requestFrom('model-service', 'model-service', 'saveProvider', {
      id: 'archive-provider', name: 'Archive Provider', baseUrl: 'https://archive.invalid', secret: 'archive-secret',
      models: [{ id: 'archive-model', streaming: true }], defaultModel: 'archive-model',
    });
    const conversation = await runtime.messages.request('agent', 'createConversation', 'harbors', projectRoot, { model: 'archive-model' }) as { id: string };
    await runtime.messages.request('conversation', 'select', conversation.id);
    const sending = runtime.messages.request('agent', 'sendMessage', conversation.id, '运行中不可归档', { model: 'archive-model' });
    await waitFor(async () => fetchMock.mock.calls.length, (value) => value > 0);
    await waitFor(
      () => runtime.messages.request('agent', 'getConversationTrace', conversation.id) as Promise<Array<{ type: string }>>,
      (trace) => trace.some((event) => event.type === 'item/delta'),
    );
    const traceWhileActive = await runtime.messages.request('agent', 'getConversationTrace', conversation.id);
    const stateBefore = await waitFor(
      () => runtime.messages.request('conversation', 'getState') as Promise<{ running: boolean }>,
      (value) => value.running,
    );
    const archiveBroadcastsBefore = runtime.observer.events.filter((event) => event.kind === 'broadcast' && event.topic === 'agent.conversation.changed' && (event.args[0] as any)?.action === 'archive').length;
    await expect(runtime.messages.requestFrom('conversation', 'conversation', 'archiveConversation', conversation.id)).resolves.toMatchObject({ ok: false, error: { code: 'CONVERSATION_ACTIVE' } });
    expect(await runtime.messages.request('agent', 'getConversationTrace', conversation.id)).toEqual(traceWhileActive);
    expect(await runtime.messages.request('conversation', 'getState')).toEqual(stateBefore);
    expect(runtime.observer.events.filter((event) => event.kind === 'broadcast' && event.topic === 'agent.conversation.changed' && (event.args[0] as any)?.action === 'archive')).toHaveLength(archiveBroadcastsBefore);

    expect(await runtime.messages.request('agent', 'stopConversation', conversation.id)).toBe(true);
    await expect(sending).rejects.toMatchObject({ code: 'MODEL_SERVICE_CANCELLED' }); pending.close();
    const traceBefore = await runtime.messages.request('agent', 'getConversationTrace', conversation.id);
    await expect(runtime.messages.requestFrom('conversation', 'conversation', 'archiveConversation', conversation.id)).resolves.toMatchObject({ ok: true, value: { id: conversation.id } });
    await runtime.dispose();

    const restarted = createAssembly('assembly-archive-restart', applicationData); harnesses.push(restarted); await restarted.kit.load();
    await expect(restarted.messages.requestFrom('conversation', 'conversation', 'listArchivedConversations')).resolves.toMatchObject({ ok: true, value: [expect.objectContaining({ id: conversation.id })] });
    await expect(restarted.messages.requestFrom('conversation', 'conversation', 'restoreConversation', conversation.id)).resolves.toMatchObject({ ok: true, value: { id: conversation.id } });
    const traceAfter = await restarted.messages.request('agent', 'getConversationTrace', conversation.id) as Array<Record<string, any>>;
    expect(traceAfter.slice(0, (traceBefore as Array<unknown>).length).map((event) => [event.type, event.seq, event.data])).toEqual((traceBefore as Array<Record<string, any>>).map((event) => [event.type, event.seq, event.data]));
    expect(traceAfter.slice(-2).map((event) => event.type)).toEqual(['conversation/archive', 'conversation/restore']);
  });

  it('fails closed for a damaged SQLite store and does not replace it with an empty database', async () => {
    const applicationData = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-assembly-archive-damaged-'));
    temporaryDirectories.push(applicationData);
    const runtime = createAssembly('assembly-archive-damaged', applicationData); harnesses.push(runtime); await runtime.kit.load();
    await runtime.messages.request('agent', 'createConversation', 'harbors', projectRoot);
    await runtime.dispose();
    const sqlite = snapshotTree(applicationData).find((entry) => entry.path.endsWith('/context.sqlite'))!;
    const sqlitePath = path.join(applicationData, sqlite.path);
    fs.writeFileSync(sqlitePath, 'damaged sqlite evidence', 'utf8');
    const damaged = fs.readFileSync(sqlitePath);
    const restarted = createAssembly('assembly-archive-damaged', applicationData); harnesses.push(restarted);
    await expect(restarted.kit.load()).rejects.toThrow();
    expect(fs.readFileSync(sqlitePath)).toEqual(damaged);
  });

  it('rejects non-Conversation callers for every Agent archive route without side effects', async () => {
    const applicationData = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-assembly-archive-callers-'));
    temporaryDirectories.push(applicationData);
    const runtime = createAssembly('assembly-archive-callers', applicationData); harnesses.push(runtime);
    await runtime.kit.load();
    const created = await runtime.messages.request('agent', 'createConversation', 'harbors', projectRoot) as { id: string };
    await runtime.messages.request('conversation', 'select', created.id);
    const archived = await runtime.messages.request('conversation', 'archiveConversation', created.id) as { ok: boolean; value?: { id: string } };
    const archivedId = archived.ok ? archived.value!.id : created.id;
    for (const [route, args] of [['listArchivedConversations', []], ['archiveConversation', [created.id]], ['restoreConversation', [archivedId]], ['deleteArchivedConversation', [archivedId]]] as const) {
      const beforeList = await runtime.messages.request('agent', 'listConversations');
      const beforeState = await runtime.messages.request('conversation', 'getState');
      const beforeTrace = await runtime.messages.request('agent', 'getConversationTrace', archivedId).catch(() => null);
      const beforeBroadcasts = runtime.observer.events.filter((event) => event.kind === 'broadcast').length;
      await expect(runtime.messages.request('agent', route, ...args)).rejects.toThrow(/not permitted/);
      for (const caller of ['settings', 'agent', 'chat']) await expect(runtime.messages.requestFrom(caller, 'agent', route, ...args)).rejects.toThrow(/not permitted/);
      expect(await runtime.messages.request('agent', 'listConversations')).toEqual(beforeList);
      expect(await runtime.messages.request('conversation', 'getState')).toEqual(beforeState);
      expect(await runtime.messages.request('agent', 'getConversationTrace', archivedId).catch(() => null)).toEqual(beforeTrace);
      expect(runtime.observer.events.filter((event) => event.kind === 'broadcast')).toHaveLength(beforeBroadcasts);
    }
    await expect(runtime.messages.request('conversation', 'deleteArchivedConversation', archivedId)).rejects.toThrow(/not permitted/);
    await expect(runtime.messages.requestFrom('chat', 'conversation', 'deleteArchivedConversation', archivedId)).rejects.toThrow(/not permitted/);
    await expect(runtime.messages.requestFrom('settings', 'conversation', 'listKnownProjects')).rejects.toThrow(/not permitted/);
    await expect(runtime.messages.requestFrom('chat', 'conversation', 'listKnownProjects')).resolves.toMatchObject({ ok: true });
    await expect(runtime.messages.requestFrom('conversation', 'agent', 'listArchivedConversations')).resolves.toMatchObject({ ok: true });
  });
});

function normalToolCall(): Response {
  return streamResponse([
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-write', function: { name: 'write', arguments: '{"file_path":"approval.txt","content":"no"}' } }] } }] })}\n\n`,
    'data: [DONE]\n\n',
  ]);
}
