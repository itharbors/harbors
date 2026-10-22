import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createKitAssemblyHarness, type KitAssemblyHarness } from '@itharbors/server/testing';

const here = path.dirname(fileURLToPath(import.meta.url));
const Database = createRequire(import.meta.url)('../../../../../packages/server/node_modules/better-sqlite3') as any;
const projectRoot = path.resolve(here, '../../../../..');
const harnesses: KitAssemblyHarness[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.dispose();
  while (temporaryDirectories.length) await rm(temporaryDirectories.pop()!, { recursive: true, force: true });
  delete process.env.HARBORS_AGENT_CONTEXT_MODE;
});

async function durabilityRuntime(complete: (input: any) => unknown, cancel: (input: any) => unknown = (input) => ({ requestId: input.requestId, state: 'cancelled' })) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'agent-durable-runtime-workspace-'));
  const applicationData = await mkdtemp(path.join(tmpdir(), 'agent-durable-runtime-data-'));
  temporaryDirectories.push(workspace, applicationData);
  const harness = createKitAssemblyHarness({ projectRoot, kitDirectory: path.join(projectRoot, 'kits/harness'), kitName: 'harness', identity: { userId: 'agent-durable-runtime-user', sessionId: 'agent-durable-runtime-session' }, paths: { applicationData } });
  harnesses.push(harness);
  await harness.kit.load();
  for (const name of ['getCatalog', 'complete', 'cancel']) harness.messages.unregisterRequest('model-service', name);
  harness.messages.registerRequest({ plugin: 'model-service', name: 'getCatalog', callers: ['agent'], handler: () => ({ models: [{ id: 'test-model', name: 'Test' }], defaultModel: 'test-model' }) });
  harness.messages.registerRequest({ plugin: 'model-service', name: 'complete', callers: ['agent'], handler: complete });
  harness.messages.registerRequest({ plugin: 'model-service', name: 'cancel', callers: ['agent'], handler: cancel });
  const commitChecks: boolean[] = [];
  harness.observer.subscribe((observed) => {
    if (observed.kind !== 'broadcast' || observed.topic !== 'agent.conversation.trace.append') return;
    const payload = observed.args[0] as any;
    try {
      const stored = harness.plugin.call<any[]>('agent-context-store', 'getConversationTrace', payload.conversationId.slice('harbors:'.length));
      commitChecks.push(stored.some((event) => event.seq === payload.event.seq && event.type === payload.event.type));
    } catch { commitChecks.push(false); }
  });
  return { harness, workspace, commitChecks };
}

function payload(event: { args: readonly unknown[] }): any { return event.args[0]; }

describe('Agent Plugin runtime smoke', () => {
  it.each(['stream', 'fallback'])('%s commits trace before delta and terminal before completed status through real routes', async (mode) => {
    let resolve!: (response: any) => void;
    let request: any;
    const response = new Promise((yes) => { resolve = yes; });
    const { harness, workspace, commitChecks } = await durabilityRuntime((input) => { request = input; return response; });
    const conversation: any = await harness.messages.requestFrom('chat', 'agent', 'createConversation', 'harbors', workspace);
    const sending = harness.messages.requestFrom('chat', 'agent', 'sendMessage', conversation.id, 'hello');
    await harness.observer.waitFor((event) => event.kind === 'request' && event.plugin === 'model-service' && event.name === 'complete');
    if (mode === 'stream') {
      for (const [sequence, text] of ['a', 'b'].entries()) harness.messages.broadcast('model-service.complete.delta', { requestId: request.requestId, generation: request.generation, sequence, delta: { type: 'text', text } });
    }
    resolve({ requestId: request.requestId, model: 'test-model', message: { role: 'assistant', content: 'ab' } });
    await expect(sending).resolves.toMatchObject({ role: 'assistant', content: 'ab' });
    await harness.observer.waitFor((event) => event.kind === 'broadcast' && event.topic === 'agent.message.status' && payload(event).conversationId === conversation.id && payload(event).status.phase === 'completed');
    const broadcasts = harness.observer.events.filter((event) => event.kind === 'broadcast' && payload(event)?.conversationId === conversation.id);
    const deltas = broadcasts.filter((event) => event.topic === 'agent.message.delta');
    expect(deltas.map((event) => payload(event).delta)).toEqual(mode === 'stream' ? ['a', 'b'] : ['ab']);
    for (const delta of deltas) {
      const committed = broadcasts.find((event) => event.topic === 'agent.conversation.trace.append' && payload(event).event.type === 'item/delta' && payload(event).event.data.item.delta?.requestId === request.requestId && payload(event).event.data.item.delta.sequence === payload(delta).sequence)!;
      expect(committed.sequence).toBeLessThan(delta.sequence);
    }
    const assistantCompleted = broadcasts.find((event) => event.topic === 'agent.conversation.trace.append' && payload(event).event.type === 'item/completed' && payload(event).event.data.item.snapshot?.role === 'assistant')!;
    const stepEnd = broadcasts.find((event) => event.topic === 'agent.conversation.trace.append' && payload(event).event.type === 'step/end')!;
    const turnEnd = broadcasts.find((event) => event.topic === 'agent.conversation.trace.append' && payload(event).event.type === 'turn/end')!;
    const completed = broadcasts.find((event) => event.topic === 'agent.message.status' && payload(event).status.phase === 'completed')!;
    expect(deltas.at(-1)!.sequence).toBeLessThan(assistantCompleted.sequence);
    expect(assistantCompleted.sequence).toBeLessThan(stepEnd.sequence);
    expect(stepEnd.sequence).toBeLessThan(turnEnd.sequence);
    expect(turnEnd.sequence).toBeLessThan(completed.sequence);
    expect(payload(turnEnd).event.data.reason.kind).toBe('completed');
    expect(commitChecks.length).toBeGreaterThan(0);
    expect(commitChecks.every(Boolean)).toBe(true);
    expect(harness.observer.events.some((event) => event.kind === 'request' && event.caller === 'chat' && event.plugin === 'agent' && event.name === 'sendMessage')).toBe(true);
  });

  it('Stop returns true only after cancelled commit and ignores late model delta through real routes', async () => {
    let reject!: (error: unknown) => void;
    let request: any;
    const response = new Promise((_yes, no) => { reject = no; });
    const { harness, workspace, commitChecks } = await durabilityRuntime((input) => { request = input; return response; }, (input) => {
      reject(Object.assign(new Error('test cancellation'), { code: 'MODEL_SERVICE_CANCELLED', requestId: input.requestId }));
      return { requestId: input.requestId, state: 'cancelled' };
    });
    const conversation: any = await harness.messages.requestFrom('chat', 'agent', 'createConversation', 'harbors', workspace);
    const sending = harness.messages.requestFrom('chat', 'agent', 'sendMessage', conversation.id, 'hello');
    void sending.catch(() => undefined);
    await harness.observer.waitFor((event) => event.kind === 'request' && event.plugin === 'model-service' && event.name === 'complete');
    await expect(harness.messages.requestFrom('chat', 'agent', 'stopConversation', conversation.id)).resolves.toBe(true);
    await expect(sending).rejects.toMatchObject({ code: 'MODEL_SERVICE_CANCELLED' });
    await harness.observer.waitFor((event) => event.kind === 'broadcast' && event.topic === 'agent.message.status' && payload(event).conversationId === conversation.id && payload(event).status.message === '已停止当前对话');
    harness.messages.broadcast('model-service.complete.delta', { requestId: request.requestId, generation: request.generation, sequence: 0, delta: { type: 'text', text: 'late' } });
    await new Promise((resolve) => setImmediate(resolve));
    const broadcasts = harness.observer.events.filter((event) => event.kind === 'broadcast' && payload(event)?.conversationId === conversation.id);
    const ends = broadcasts.filter((event) => event.topic === 'agent.conversation.trace.append' && payload(event).event.type === 'turn/end');
    expect(ends).toHaveLength(1);
    expect(payload(ends[0]).event.data.reason.kind).toBe('cancelled');
    const stopped = broadcasts.find((event) => event.topic === 'agent.message.status' && payload(event).status.message === '已停止当前对话')!;
    expect(ends[0].sequence).toBeLessThan(stopped.sequence);
    expect(broadcasts.some((event) => event.topic === 'agent.message.delta' || event.topic === 'agent.message.status' && payload(event).status.phase === 'completed')).toBe(false);
    expect(harness.observer.events.some((event) => event.kind === 'request' && event.caller === 'agent' && event.plugin === 'model-service' && event.name === 'cancel' && payload(event).requestId === request.requestId)).toBe(true);
    expect(commitChecks.every(Boolean)).toBe(true);
  });

  it('requestId-only approval commits before confirmation and mutation through real routes', async () => {
    let modelCalls = 0;
    const { harness, workspace, commitChecks } = await durabilityRuntime((input) => {
      modelCalls += 1;
      return { requestId: input.requestId, model: 'test-model', message: modelCalls === 1 ? { role: 'assistant', content: '', toolCalls: [{ id: 'approved-write', name: 'write', arguments: '{"file_path":"approved.txt","content":"once"}' }] } : { role: 'assistant', content: 'done' } };
    });
    const conversation: any = await harness.messages.requestFrom('chat', 'agent', 'createConversation', 'harbors', workspace, { sandboxMode: 'read-only', approvalPolicy: 'ask' });
    const sending = harness.messages.requestFrom('chat', 'agent', 'sendMessage', conversation.id, 'write');
    void sending.catch(() => undefined);
    await harness.observer.waitFor((event) => event.kind === 'broadcast' && event.topic === 'agent.message.status' && payload(event).conversationId === conversation.id && payload(event).status.phase === 'waiting_permission');
    const requests = await harness.messages.requestFrom('chat', 'agent', 'getPendingPermissionRequests', conversation.id) as any[];
    expect(requests).toHaveLength(1);
    await expect(harness.messages.requestFrom('chat', 'agent', 'sendMessage', conversation.id, 'concurrent')).rejects.toThrow(/已有正在执行/);
    expect(await harness.messages.requestFrom('chat', 'agent', 'getPendingPermissionRequests', conversation.id)).toEqual(requests);
    const resolving = harness.messages.requestFrom('chat', 'agent', 'resolvePermissionRequest', { requestId: requests[0].requestId, outcome: 'allowed-once' });
    await expect(harness.messages.requestFrom('chat', 'agent', 'resolvePermissionRequest', { requestId: requests[0].requestId, outcome: 'allowed-once' })).resolves.toBe(false);
    await expect(resolving).resolves.toBe(true);
    await expect(sending).resolves.toMatchObject({ content: 'done' });
    await harness.observer.waitFor((event) => event.kind === 'broadcast' && event.topic === 'agent.message.status' && payload(event).conversationId === conversation.id && payload(event).status.message === '权限已确认，继续执行…');
    const broadcasts = harness.observer.events.filter((event) => event.kind === 'broadcast' && payload(event)?.conversationId === conversation.id);
    const trace = broadcasts.filter((event) => event.topic === 'agent.conversation.trace.append');
    const asked = trace.find((event) => payload(event).event.type === 'approval/asked')!;
    const waiting = broadcasts.find((event) => event.topic === 'agent.message.status' && payload(event).status.phase === 'waiting_permission')!;
    const resolved = trace.find((event) => payload(event).event.type === 'approval/resolved')!;
    const approvalCompleted = trace.find((event) => payload(event).event.type === 'item/completed' && payload(event).event.itemKind === 'approval')!;
    const confirmed = broadcasts.find((event) => event.topic === 'agent.message.status' && payload(event).status.message === '权限已确认，继续执行…')!;
    const results = trace.filter((event) => payload(event).event.type === 'tool/result');
    expect(asked.sequence).toBeLessThan(waiting.sequence);
    expect(resolved.sequence).toBeLessThan(approvalCompleted.sequence);
    expect(approvalCompleted.sequence).toBeLessThan(confirmed.sequence);
    expect(results).toHaveLength(1);
    expect(approvalCompleted.sequence).toBeLessThan(results[0].sequence);
    expect(await readFile(path.join(workspace, 'approved.txt'), 'utf8')).toBe('once');
    expect(modelCalls).toBe(2);
    expect(commitChecks.every(Boolean)).toBe(true);
  });

  it('persists Settings and sends framed instructions through the real message chain', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'agent-runtime-workspace-'));
    const applicationData = await mkdtemp(path.join(tmpdir(), 'agent-runtime-data-'));
    await mkdir(path.join(workspace, '.agents/skills/demo'), { recursive: true });
    await writeFile(path.join(workspace, '.agents/skills/demo/SKILL.md'), '---\nname: demo\ndescription: Demo runtime skill\n---\nFollow this demo.\n');
    await mkdir(path.join(workspace, '.agents/skills/oversized'), { recursive: true });
    await writeFile(path.join(workspace, '.agents/skills/oversized/SKILL.md'), `---\nname: oversized\ndescription: Oversized runtime skill\n---\n${'x'.repeat(12_100)}\n`);
    await writeFile(path.join(workspace, 'ordinary.txt'), 'ordinary workspace content\n');
    const completeRequests: any[] = [];
    const harness = createKitAssemblyHarness({ projectRoot, kitDirectory: path.join(projectRoot, 'kits/harness'), kitName: 'harness', identity: { userId: 'agent-runtime-user', sessionId: 'agent-runtime-session' }, paths: { applicationData } });
    harnesses.push(harness);
    await harness.kit.load();
    for (const name of ['getCatalog', 'complete', 'cancel']) harness.messages.unregisterRequest('model-service', name);
    harness.messages.registerRequest({ plugin: 'model-service', name: 'getCatalog', callers: ['agent'], handler: () => ({ models: [{ id: 'test-model', name: 'Test' }], defaultModel: 'test-model' }) });
    harness.messages.registerRequest({ plugin: 'model-service', name: 'complete', callers: ['agent'], handler: (input) => {
      completeRequests.push(input);
      if (completeRequests.length === 1) return { requestId: (input as any).requestId, model: 'test-model', message: { role: 'assistant', content: '', toolCalls: [
        { id: 'load-demo', name: 'load_skill', arguments: '{"name":"demo"}' },
        { id: 'load-oversized', name: 'load_skill', arguments: '{"name":"oversized"}' },
        { id: 'read-ordinary', name: 'read', arguments: '{"file_path":"ordinary.txt"}' },
      ] } };
      return { requestId: (input as any).requestId, model: 'test-model', message: { role: 'assistant', content: 'done' } };
    } });
    harness.messages.registerRequest({ plugin: 'model-service', name: 'cancel', callers: ['agent'], handler: (input) => ({ requestId: (input as any).requestId, state: 'cancelled' }) });

    const initial = await Promise.resolve(harness.plugin.call<any>('agent', 'getSettings'));
    expect(initial.custom).toMatchObject({ applied: false, code: 'disabled' });
    const saved = await Promise.resolve(harness.plugin.call<any>('agent', 'saveSettings', { sandboxMode: 'workspace-write', approvalPolicy: 'ask', customInstructions: 'Always mention runtime evidence.' }));
    expect(saved.custom).toMatchObject({ configured: true, applied: true, code: 'ok' });
    await expect(Promise.resolve(harness.plugin.call('agent', 'saveSettings', { sandboxMode: 'workspace-write', approvalPolicy: 'ask', customInstructions: { unsafe: true } }))).rejects.toThrow(/must be a string/);
    await expect(Promise.resolve(harness.plugin.call('agent', 'saveSettings', { sandboxMode: 'workspace-write', approvalPolicy: 'ask', customInstructions: '你'.repeat(2731) }))).rejects.toThrow(/8192 UTF-8 bytes/);

    const conversation = await Promise.resolve(harness.plugin.call<any>('agent', 'createConversation', 'harbors', workspace));
    await expect(Promise.resolve(harness.plugin.call('agent', 'sendMessage', conversation.id, 'hello'))).resolves.toMatchObject({ role: 'assistant', content: 'done' });
    expect(completeRequests).toHaveLength(2);
    expect(completeRequests[0]).toMatchObject({ purpose: 'turn', model: 'test-model' });
    expect(completeRequests[0].system).toContain('@@harbors-section agent_core');
    expect(completeRequests[0].system).toContain('Always mention runtime evidence.');
    expect(completeRequests[0].system).toContain('Demo runtime skill');
    expect(completeRequests[0].tools.map((tool: any) => tool.name)).toContain('load_skill');
    expect(completeRequests[0].tools.map((tool: any) => tool.name)).not.toContain('list_skills');
    expect(harness.observer.events.some((event) => event.kind === 'request' && event.plugin === 'model-service' && event.name === 'getCatalog')).toBe(true);
    expect(harness.observer.events.some((event) => event.kind === 'request' && event.plugin === 'model-service' && event.name === 'complete')).toBe(true);
    const trace = await Promise.resolve(harness.plugin.call<any[]>('agent', 'getConversationTrace', conversation.id));
    const requestContexts = trace.filter((event) => event.type === 'request/context');
    expect(requestContexts).toHaveLength(2);
    const requestContext = requestContexts[0];
    expect(requestContexts.every((event) => typeof event.data.planId === 'string' && event.data.builderVersion === 'candidate-v1')).toBe(true);
    expect(requestContexts.every((event) => /^[0-9a-f]{64}$/.test(event.data.historyDigest))).toBe(true);
    expect(requestContext.data.promptVersion).toBe('harbors-agent-core/v1');
    expect(requestContext.data.promptDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(requestContext.data.instructionSources)).not.toContain('Always mention runtime evidence.');
    expect(JSON.stringify(requestContext.data.instructionSources)).not.toContain(workspace);
    expect(requestContexts.map((event) => event.data.loadedSkills)).toEqual([[], ['demo']]);
    expect(requestContexts[1].data.promptDigest).toBe(requestContext.data.promptDigest);
    expect(completeRequests[1].system).toBe(completeRequests[0].system);
    const secondMessages = completeRequests[1].messages as Array<{ role: string; toolCallId?: string; toolCalls?: unknown[] }>;
    expect(secondMessages.some((message) => message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length === 3)).toBe(true);
    expect(secondMessages.filter((message) => message.role === 'tool').map((message) => message.toolCallId).sort()).toEqual(['load-demo', 'load-oversized', 'read-ordinary']);
    const toolResults = trace.filter((event) => event.type === 'tool/result').map((event) => event.data.item.snapshot);
    const toolResultsByCallId = new Map(toolResults.map((result) => [result.callId, result]));
    expect([...toolResultsByCallId.keys()].sort()).toEqual(['load-demo', 'load-oversized', 'read-ordinary']);
    expect(toolResultsByCallId.get('load-demo')).toMatchObject({ callId: 'load-demo', isError: false });
    expect(toolResultsByCallId.get('load-demo')?.result).toContain('Follow this demo.');
    expect(toolResultsByCallId.get('load-oversized')).toMatchObject({ callId: 'load-oversized', isError: true });
    expect(toolResultsByCallId.get('load-oversized')?.result).toMatch(/12000 UTF-8/);
    expect(toolResultsByCallId.get('read-ordinary')).toMatchObject({ callId: 'read-ordinary', isError: false });
    expect(toolResultsByCallId.get('read-ordinary')?.result).toContain('ordinary workspace content');
    expect(trace.find((event) => event.type === 'turn/end')?.data.loadedSkills).toEqual(['demo']);

    const database = new Database(path.join(applicationData, 'users', createHash('sha256').update('agent-runtime-user').digest('hex'), 'config.sqlite'));
    const seedCustom = (value: unknown) => database.prepare(`
      INSERT INTO config_values (kit_id, plugin_name, layer_name, key, value_json)
      VALUES ('harness', 'agent', 'global', 'agent.instructions.custom', ?)
      ON CONFLICT (kit_id, plugin_name, layer_name, key) DO UPDATE SET value_json = excluded.value_json
    `).run(JSON.stringify(value));
    seedCustom({ unsafe: 'runtime-secret-object' });
    expect((await Promise.resolve(harness.plugin.call<any>('agent', 'getSettings'))).custom.code).toBe('invalid_type');
    const invalidConversation = await Promise.resolve(harness.plugin.call<any>('agent', 'createConversation', 'harbors', workspace));
    await Promise.resolve(harness.plugin.call('agent', 'sendMessage', invalidConversation.id, 'invalid custom config'));
    expect(completeRequests.at(-1).system).not.toContain('runtime-secret-object');
    seedCustom(`runtime-secret-oversized-${'你'.repeat(2731)}`);
    expect((await Promise.resolve(harness.plugin.call<any>('agent', 'getSettings'))).custom.code).toBe('too_large');
    const oversizedConversation = await Promise.resolve(harness.plugin.call<any>('agent', 'createConversation', 'harbors', workspace));
    await Promise.resolve(harness.plugin.call('agent', 'sendMessage', oversizedConversation.id, 'oversized custom config'));
    expect(completeRequests.at(-1).system).not.toContain('runtime-secret-oversized');

    const reset = await Promise.resolve(harness.plugin.call<any>('agent', 'resetSettings'));
    expect(reset.custom).toMatchObject({ configured: false, applied: false, code: 'disabled' });
    const afterReset = await Promise.resolve(harness.plugin.call<any>('agent', 'getSettings'));
    expect(afterReset.global.customInstructions).toBe(false);
    expect(afterReset.customInstructions).toBe('');
    expect(database.prepare("SELECT COUNT(*) AS count FROM config_values WHERE kit_id = 'harness' AND plugin_name = 'agent' AND key = 'agent.instructions.custom'").get()).toEqual({ count: 0 });
    database.close();
  });
});
