import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createKitAssemblyHarness, type KitAssemblyHarness } from '@itharbors/server/testing';

const here = path.dirname(fileURLToPath(import.meta.url));
const Database = createRequire(import.meta.url)('../../../../../packages/server/node_modules/better-sqlite3') as any;
const projectRoot = path.resolve(here, '../../../../..');
const harnesses: KitAssemblyHarness[] = [];

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.dispose();
});

describe('Agent Plugin runtime smoke', () => {
  it('persists Settings and sends framed instructions through the real message chain', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'agent-runtime-workspace-'));
    const applicationData = await mkdtemp(path.join(tmpdir(), 'agent-runtime-data-'));
    await mkdir(path.join(workspace, '.agents/skills/demo'), { recursive: true });
    await writeFile(path.join(workspace, '.agents/skills/demo/SKILL.md'), '---\nname: demo\ndescription: Demo runtime skill\n---\nFollow this demo.\n');
    await mkdir(path.join(workspace, '.agents/skills/oversized'), { recursive: true });
    await writeFile(path.join(workspace, '.agents/skills/oversized/SKILL.md'), `---\nname: oversized\ndescription: Oversized runtime skill\n---\n${'x'.repeat(12_100)}\n`);
    await writeFile(path.join(workspace, 'ordinary.txt'), 'ordinary workspace content\n');
    const completeRequests: any[] = [];
    const harness = createKitAssemblyHarness({ projectRoot, kitDirectory: path.join(projectRoot, 'kits/harness'), kitName: 'harness', paths: { applicationData } });
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
    expect(requestContext.data.promptVersion).toBe('harbors-agent-core/v1');
    expect(requestContext.data.promptDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(requestContext.data.instructionSources)).not.toContain('Always mention runtime evidence.');
    expect(JSON.stringify(requestContext.data.instructionSources)).not.toContain(workspace);
    expect(requestContexts.map((event) => event.data.loadedSkills)).toEqual([[], ['demo']]);
    expect(requestContexts[1].data.promptDigest).toBe(requestContext.data.promptDigest);
    expect(completeRequests[1].system).toBe(completeRequests[0].system);
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

    const database = new Database(path.join(applicationData, 'config.sqlite'));
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
