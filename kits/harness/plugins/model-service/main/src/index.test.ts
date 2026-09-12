import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ModelService } from './index.js';
import { buildRequest } from './protocol.js';
import type { ConfigReader, CredentialReader, ModelProvider } from './config.js';
import type { CompleteInput } from './types.js';

const secret = 'fake-secret-never-returned';
const input: CompleteInput = { requestId: 'r-1', purpose: 'turn', messages: [{ role: 'user', content: 'hello' }] };
const response = (body: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(body), { status, headers });

function makeProvider(overrides: Partial<ModelProvider> = {}): ModelProvider {
  return { id: 'relay', name: 'Relay', protocol: 'openai-chat-completions', baseUrl: 'https://relay.invalid', credentialId: 'credential-1', models: [{ id: 'test-model', name: 'Test Model' }], defaultModel: 'test-model', ...overrides };
}

function makeConfig(provider: ModelProvider = makeProvider(), extra: Record<string, unknown> = {}): ConfigReader {
  const service = { providers: [provider], defaultProviderId: provider.id, ...extra };
  return { get<T>(key: string): T | undefined { return key === 'service' ? service as T : undefined; } };
}

function makeCredentials(options: { secret?: string; error?: Error } = {}): CredentialReader {
  return {
    async get(id: string) {
      if (options.error) throw options.error;
      return { profile: { id }, secret: options.secret ?? secret };
    },
  };
}

function makeService(fetcher: typeof fetch, provider?: ModelProvider, credentials?: CredentialReader): ModelService {
  return new ModelService({ config: makeConfig(provider), credentials: credentials ?? makeCredentials(), fetch: fetcher });
}

function makeDraftHarness() {
  let serviceValue: unknown = { providers: [] };
  const stored: Array<{ id?: string; label: string; secret: string }> = [];
  const config: ConfigReader = {
    get<T>(key: string): T | undefined { return key === 'service' ? serviceValue as T : undefined; },
    set(_key: string, value: unknown) { serviceValue = value; },
  };
  const credentials: CredentialReader = {
    async get(id: string) { return { profile: { id }, secret }; },
    async put(value) { stored.push({ id: value.id, label: value.label, secret: value.secret }); return { id: value.id || `credential-${stored.length}` }; },
  };
  return { config, credentials, stored, read: () => serviceValue as { providers: ModelProvider[]; defaultProviderId?: string } };
}

function makeBroadcastRecorder() {
  const events: Array<{ topic: string; payload: unknown }> = [];
  return {
    events,
    message: { broadcast(topic: string, payload: unknown) { events.push({ topic, payload }); } },
  };
}

test('catalog uses bound config and hides credential metadata', async () => {
  const catalog = await makeService(async () => response({})).getCatalog();
  assert.equal(catalog.defaultModel, 'test-model');
  assert.equal(catalog.models[0]?.id, 'test-model');
  assert.doesNotMatch(JSON.stringify(catalog), /fake-secret|credential-1/u);
});

test('settings snapshot includes all providers and exposes only credentialConfigured', () => {
  const first = makeProvider({ id: 'first', credentialId: 'credential-first' });
  const second = makeProvider({ id: 'second', credentialId: '' });
  const service = new ModelService({ config: makeConfig(first, { providers: [first, second] }) });
  const snapshot = service.getSettings();
  assert.deepEqual(snapshot.providers.map((provider) => provider.id), ['first', 'second']);
  assert.equal(snapshot.providers[0]?.credentialConfigured, true);
  assert.equal(snapshot.providers[1]?.credentialConfigured, false);
  assert.equal('credentialId' in snapshot.providers[0]!, false);
  assert.doesNotMatch(JSON.stringify(snapshot), /credential-first|fake-secret-never-returned/u);
});

test('reports stable configuration errors for missing address and credential', async () => {
  const missingAddress = await makeService(async () => response({}), makeProvider({ baseUrl: '' })).getCatalog();
  assert.equal(missingAddress.configurationError?.code, 'MISSING_BASE_URL');
  const missingCredential = await makeService(async () => response({}), makeProvider({ credentialId: '' })).getCatalog();
  assert.equal(missingCredential.configurationError?.code, 'MISSING_CREDENTIAL');
});

test('credential locked and not-found errors map to not-configured without leaking details', async () => {
  for (const reason of ['CREDENTIALS_LOCKED', 'CREDENTIAL_NOT_FOUND']) {
    const error = new Error(`${reason}: ${secret}`);
    const service = makeService(async () => response({}), undefined, makeCredentials({ error }));
    const catalog = await service.getCatalog();
    assert.equal(catalog.configurationError?.code, 'MISSING_CREDENTIAL');
    await assert.rejects(service.complete(input), (failure: any) => {
      assert.equal(failure.code, 'MODEL_SERVICE_NOT_CONFIGURED');
      assert.doesNotMatch(String(failure), new RegExp(secret, 'u'));
      assert.doesNotMatch(String(failure), new RegExp(reason, 'u'));
      return true;
    });
  }
});

test('builds OpenAI payload and normalizes tool calls and usage', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const service = makeService(async (url, init) => { seen = { url: String(url), init: init || {} }; return response({ choices: [{ message: { content: 'ok', tool_calls: [{ id: 'call-1', function: { name: 'read', arguments: '{"path":"a"}' } }] } }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } }); });
  const result = await service.complete({ ...input, tools: [{ name: 'read', description: 'read', inputSchema: { type: 'object' } }] });
  const body = JSON.parse(String(seen!.init.body));
  assert.equal(seen!.url, 'https://relay.invalid/chat/completions');
  assert.equal((seen!.init.headers as Record<string, string>).authorization, `Bearer ${secret}`);
  assert.equal(body.tools[0].function.name, 'read');
  assert.equal(result.message.toolCalls?.[0]?.arguments, '{"path":"a"}');
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 4, totalTokens: 16 });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret, 'u'));
});

test('builds Anthropic payload with image and normalizes text/tool use', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const service = makeService(async (url, init) => { seen = { url: String(url), init: init || {} }; return response({ content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'call-1', name: 'read', input: { path: 'a' } }], usage: { input_tokens: 10, output_tokens: 3 } }); }, makeProvider({ protocol: 'anthropic-messages', baseUrl: 'https://relay.invalid/' }));
  const result = await service.complete({ ...input, system: 'system', messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', mediaType: 'image/png', data: 'AA==' }] }] });
  const body = JSON.parse(String(seen!.init.body));
  assert.equal(seen!.url, 'https://relay.invalid/v1/messages');
  assert.equal((seen!.init.headers as Record<string, string>)['x-api-key'], secret);
  assert.equal(body.system, 'system');
  assert.equal(body.messages[0].content[1].source.data, 'AA==');
  assert.equal(result.message.toolCalls?.[0]?.name, 'read');
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 3, totalTokens: 13 });
});

test('retries transient errors and supports disabled retries', async () => {
  let calls = 0;
  const provider = makeProvider({ options: { baseDelayMs: 0, maxRetries: 2 } });
  const service = makeService(async () => { calls += 1; return calls === 1 ? response({ error: 'busy' }, 503) : response({ choices: [{ message: { content: 'ok' } }] }); }, provider);
  await service.complete(input);
  assert.equal(calls, 2);
  const disabled = makeService(async () => response({ error: 'busy' }, 503), makeProvider({ options: { retryEnabled: false } }));
  await assert.rejects(disabled.complete({ ...input, requestId: 'r-disabled' }), (error: any) => error.code === 'MODEL_SERVICE_HTTP_ERROR');
});

test('cancel and unload expose stable error codes', async () => {
  let release!: () => void;
  const pending = new Promise<Response>((resolve) => { release = () => resolve(response({ choices: [{ message: { content: 'late' } }] })); });
  const service = makeService(async () => pending);
  const completion = service.complete(input);
  assert.throws(() => service.cancel('r-1' as any), (error: any) => error.code === 'INVALID_INPUT');
  assert.deepEqual(service.cancel({ requestId: 'r-1' }), { requestId: 'r-1', state: 'cancelled' });
  release();
  await assert.rejects(completion, (error: any) => error.code === 'MODEL_SERVICE_CANCELLED');
  assert.deepEqual(service.cancel({ requestId: 'r-1' }), { requestId: 'r-1', state: 'already_cancelled' });
  const stopped = makeService(async () => pending);
  const stoppedCompletion = stopped.complete({ ...input, requestId: 'stopped' });
  stopped.unload();
  await assert.rejects(stoppedCompletion, (error: any) => error.code === 'MODEL_SERVICE_STOPPED');
});

test('recognizes only matching 400 context errors and 413', async () => {
  const serverError = makeService(async () => response({ error: 'context backend unavailable' }, 500), makeProvider({ options: { retryEnabled: false } }));
  await assert.rejects(serverError.complete({ ...input, requestId: 'server-context' }), (error: any) => error.code === 'MODEL_SERVICE_HTTP_ERROR');
  const payloadError = makeService(async () => response({ error: 'invalid request' }, 400), makeProvider({ options: { retryEnabled: false } }));
  await assert.rejects(payloadError.complete({ ...input, requestId: 'bad-request' }), (error: any) => error.code === 'MODEL_SERVICE_HTTP_ERROR');
  const tooLarge = makeService(async () => response({ error: 'request exceeds context token limit' }, 400), makeProvider({ options: { retryEnabled: false } }));
  await assert.rejects(tooLarge.complete({ ...input, requestId: 'too-large' }), (error: any) => error.code === 'MODEL_SERVICE_CONTEXT_OVERFLOW');
  const status413 = makeService(async () => response({ error: 'payload too large' }, 413), makeProvider({ options: { retryEnabled: false } }));
  await assert.rejects(status413.complete({ ...input, requestId: 'too-large-413' }), (error: any) => error.code === 'MODEL_SERVICE_CONTEXT_OVERFLOW');
});

test('protocol keeps credentials private and emits tool/image endpoint shapes', () => {
  const config = { baseUrl: 'https://relay.invalid', credential: secret, api: 'openai-completions' as const, modelId: 'm', models: [], providerId: 'relay', retry: { enabled: true, maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } };
  const plan = buildRequest(config, input, 'm');
  assert.equal((plan.init.headers as Record<string, string>).authorization, `Bearer ${secret}`);
  const anthropicPlan = buildRequest({ ...config, api: 'anthropic-messages' }, { ...input, messages: [{ role: 'tool', toolCallId: 'call-1', isError: true, content: 'failed' }] }, 'm');
  const anthropicBody = JSON.parse(String(anthropicPlan.init.body));
  assert.equal(anthropicBody.messages[0].content[0].is_error, true);
  const imageToolPlan = buildRequest(config, { ...input, messages: [{ role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'result' }, { type: 'image', mediaType: 'image/png', data: 'AA==' }] }] }, 'm');
  const imageToolBody = JSON.parse(String(imageToolPlan.init.body));
  assert.equal(imageToolBody.messages.length, 2);
  assert.equal(imageToolBody.messages[0].role, 'tool');
  assert.equal(imageToolBody.messages[1].content[1].type, 'image_url');
});

test('stable error codes cover unsupported protocol, invalid response, network, and timeout', async () => {
  const notConfigured = makeService(async () => response({}), makeProvider({ credentialId: '' }));
  await assert.rejects(notConfigured.complete({ ...input, requestId: 'not-configured' }), (error: any) => error.code === 'MODEL_SERVICE_NOT_CONFIGURED');
  const unsupportedConfig = { baseUrl: 'https://relay.invalid', credential: secret, api: 'unsupported' as any, modelId: 'm', models: [], providerId: 'relay', retry: { enabled: false, maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } };
  assert.throws(() => buildRequest(unsupportedConfig, input, 'm'), (error: any) => error.code === 'MODEL_SERVICE_UNSUPPORTED_API');
  const invalid = makeService(async () => response({ choices: [] }));
  await assert.rejects(invalid.complete({ ...input, requestId: 'invalid' }), (error: any) => error.code === 'MODEL_SERVICE_INVALID_RESPONSE');
  const network = makeService(async () => { throw new TypeError('offline'); }, makeProvider({ options: { retryEnabled: false } }));
  await assert.rejects(network.complete({ ...input, requestId: 'network' }), (error: any) => error.code === 'MODEL_SERVICE_NETWORK_ERROR');
  const timed = new ModelService({ config: makeConfig(makeProvider({ options: { retryEnabled: false } })), credentials: makeCredentials(), requestTimeoutMs: 1, fetch: async () => new Promise<Response>(() => {}) });
  await assert.rejects(timed.complete({ ...input, requestId: 'timeout' }), (error: any) => error.code === 'MODEL_SERVICE_TIMEOUT' || error.code === 'MODEL_SERVICE_CANCELLED');
});

test('保存 Provider 支持先保存地址，再保存 Token，并返回安全快照', async () => {
  const harness = makeDraftHarness();
  const service = new ModelService({ config: harness.config, credentials: harness.credentials, fetch: async () => response({ choices: [{ message: { content: 'ok' } }] }) });
  const saved = await service.saveProvider({ id: 'draft', name: 'Draft', baseUrl: 'https://provider.invalid', models: [{ id: 'm' }] });
  assert.equal(saved.providers[0]?.baseUrl, 'https://provider.invalid');
  assert.equal(harness.stored.length, 0);
  await service.saveProvider({ id: 'draft', name: 'Draft', baseUrl: 'https://provider.invalid', models: [{ id: 'm' }], secret });
  assert.equal(harness.stored.length, 1);
  assert.equal(harness.read().providers[0]?.credentialId, 'credential-1');
  assert.equal((await service.complete(input)).message.content, 'ok');
});

test('保存 Provider 不带新 Token 时保留已写入 credentialId', async () => {
  const harness = makeDraftHarness();
  const service = new ModelService({ config: harness.config, credentials: harness.credentials, fetch: async () => response({ choices: [{ message: { content: 'ok' } }] }) });
  await service.saveProvider({ id: 'draft', name: 'Draft', secret });
  assert.equal(harness.stored.length, 1);
  assert.equal(harness.read().providers[0]?.baseUrl, '');
  await service.saveProvider({ id: 'draft', name: 'Draft', baseUrl: 'https://provider.invalid' });
  assert.equal(harness.read().providers[0]?.credentialId, 'credential-1');
  assert.equal((await service.complete(input)).message.content, 'ok');
});

test('保存后从绑定 Config 和 Credential Vault 重读，后续请求使用已保存凭据', async () => {
  const harness = makeDraftHarness();
  const credentialReads: string[] = [];
  let storedCredential: { id: string; secret: string } | undefined;
  const credentials: CredentialReader = {
    async get(id) {
      credentialReads.push(id);
      return { profile: { id }, secret: storedCredential?.secret || '' };
    },
    async put(value) {
      storedCredential = { id: value.id || 'credential-reread', secret: value.secret };
      return { id: storedCredential.id, label: value.label, metadata: value.metadata, createdAt: 'created', updatedAt: 'updated' };
    },
  };
  let authorization = '';
  const service = new ModelService({
    config: harness.config,
    credentials,
    fetch: async (_url, init) => {
      authorization = (init?.headers as Record<string, string>).authorization;
      return response({ choices: [{ message: { content: 'ok' } }] });
    },
  });
  const saved = await service.saveProvider({ id: 'reread', name: 'Reread', baseUrl: 'https://reread.invalid', models: [{ id: 'm' }], secret });
  assert.equal(saved.providers[0]?.id, 'reread');
  assert.equal(harness.read().providers[0]?.credentialId, 'credential-reread');
  await service.complete({ ...input, requestId: 'reread-request' });
  assert.deepEqual(credentialReads, ['credential-reread']);
  assert.equal(authorization, `Bearer ${secret}`);
});

test('兼容凭据库桥接返回的 profile 包装形状，并保持 credentialId 与 Vault profile 对齐', async () => {
  const harness = makeDraftHarness();
  const profileId = 'credential-profile-wrapper';
  let reads = 0;
  const credentials: CredentialReader = {
    async get(id) {
      reads += 1;
      return { profile: { id }, secret };
    },
    async put(value) {
      return { profile: { id: profileId, label: value.label, metadata: value.metadata, createdAt: 'created', updatedAt: 'updated' } };
    },
  };
  let authorization = '';
  const service = new ModelService({
    config: harness.config,
    credentials,
    fetch: async (_url, init) => {
      authorization = (init?.headers as Record<string, string>).authorization;
      return response({ choices: [{ message: { content: 'ok' } }] });
    },
  });

  const saved = await service.saveProvider({ id: 'wrapped', name: 'Wrapped', baseUrl: 'https://wrapped.invalid', models: [{ id: 'm' }], secret });
  assert.equal(harness.read().providers[0]?.credentialId, profileId);
  assert.equal(saved.providers[0]?.credentialConfigured, true);
  await service.complete({ ...input, requestId: 'wrapped-request' });
  assert.equal(reads, 1);
  assert.equal(authorization, `Bearer ${secret}`);
});

test('凭据库返回缺少 profile ID 时不写入不完整配置', async () => {
  const harness = makeDraftHarness();
  const service = new ModelService({ config: harness.config, credentials: { async get(id) { return { profile: { id }, secret }; }, async put() { return { profile: {} }; } } });
  await assert.rejects(service.saveProvider({ id: 'missing-profile-id', name: 'Missing profile ID', secret }), (error: any) => {
    assert.equal(error.code, 'MODEL_SERVICE_NOT_CONFIGURED');
    return true;
  });
  assert.deepEqual(harness.read().providers, []);
});

test('Vault 保存失败时不泄漏 Token', async () => {
  const harness = makeDraftHarness();
  const service = new ModelService({ config: harness.config, credentials: { async get(id) { return { profile: { id }, secret }; }, async put() { throw new Error(`vault failure ${secret}`); } } });
  await assert.rejects(service.saveProvider({ id: 'save-failed', name: 'Save failed', secret }), (error: any) => {
    assert.equal(error.code, 'MODEL_SERVICE_NOT_CONFIGURED');
    assert.doesNotMatch(String(error), /vault failure|fake-secret-never-returned/u);
    return true;
  });
  assert.deepEqual(harness.read().providers, []);
});

test('修改 providerId 会迁移旧 Provider、credentialId 和默认 Provider', async () => {
  const oldProvider = makeProvider({ id: 'old-provider', credentialId: 'credential-old' });
  const harness = makeDraftHarness();
  harness.config.set?.('service', { providers: [oldProvider], defaultProviderId: oldProvider.id }, 'global');
  let deleted = '';
  const credentials: CredentialReader = {
    async get(id) { return { profile: { id }, secret }; },
    async delete(id) { deleted = id; },
  };
  const service = new ModelService({ config: harness.config, credentials, fetch: async () => response({ choices: [{ message: { content: 'ok' } }] }) });
  await service.saveProvider({ id: 'new-provider', previousId: oldProvider.id, name: oldProvider.name, baseUrl: oldProvider.baseUrl, models: oldProvider.models });
  const saved = harness.read();
  assert.deepEqual(saved.providers.map((provider) => provider.id), ['new-provider']);
  assert.equal(saved.providers[0]?.credentialId, 'credential-old');
  assert.equal(saved.defaultProviderId, 'new-provider');
  await service.deleteProvider('new-provider');
  assert.equal(deleted, 'credential-old');
});

test('删除没有 credentialId 的草稿不会调用凭据库删除', async () => {
  const draft = makeProvider({ id: 'draft', credentialId: '' });
  const harness = makeDraftHarness();
  harness.config.set?.('service', { providers: [draft], defaultProviderId: draft.id }, 'global');
  let deleteCalls = 0;
  const service = new ModelService({ config: harness.config, credentials: { async get(id) { return { profile: { id }, secret }; }, async delete() { deleteCalls += 1; } } });
  await service.deleteProvider('draft');
  assert.equal(deleteCalls, 0);
});

test('删除 Provider 的 Vault 失败时不修改配置且不泄漏底层错误', async () => {
  const provider = makeProvider({ id: 'failed-delete', credentialId: 'credential-delete' });
  const harness = makeDraftHarness();
  harness.config.set?.('service', { providers: [provider], defaultProviderId: provider.id }, 'global');
  const service = new ModelService({ config: harness.config, credentials: { async get(id) { return { profile: { id }, secret }; }, async delete() { throw new Error(`vault failure ${secret}`); } } });
  await assert.rejects(service.deleteProvider(provider.id), (error: any) => {
    assert.equal(error.code, 'MODEL_SERVICE_NOT_CONFIGURED');
    assert.doesNotMatch(String(error), /vault failure|fake-secret-never-returned/u);
    return true;
  });
  assert.equal(harness.read().providers[0]?.credentialId, provider.credentialId);
});

test('重置 Token 会先删除 Vault 凭据，再清空当前 Provider 的 credentialId', async () => {
  const provider = makeProvider({ id: 'reset-provider', credentialId: 'credential-reset' });
  const harness = makeDraftHarness();
  harness.config.set?.('service', { providers: [provider], defaultProviderId: provider.id }, 'global');
  let deleted = '';
  const service = new ModelService({ config: harness.config, credentials: { async get(id) { return { profile: { id }, secret }; }, async delete(id) { deleted = id; } } });
  await service.resetProviderCredential({ providerId: 'reset-provider' });
  assert.equal(deleted, 'credential-reset');
  assert.equal(harness.read().providers[0]?.credentialId, '');
  assert.equal(harness.read().providers[0]?.baseUrl, provider.baseUrl);
});

test('Provider 配置变更成功后每次广播一次安全 Catalog，并递增 revision', async () => {
  const harness = makeDraftHarness();
  let deleteCalls = 0;
  const recorder = makeBroadcastRecorder();
  const service = new ModelService({
    config: harness.config,
    credentials: {
      async get(id) { return { profile: { id }, secret }; },
      async put(value) { return { id: value.id || 'credential-broadcast' }; },
      async delete() { deleteCalls += 1; },
    },
    message: recorder.message,
  });

  await service.saveProvider({ id: 'broadcast-provider', name: 'Broadcast', baseUrl: 'https://broadcast.invalid', models: [{ id: 'broadcast-model' }], secret });
  await service.resetProviderCredential({ providerId: 'broadcast-provider' });
  await service.deleteProvider('broadcast-provider');

  assert.equal(deleteCalls, 1);
  assert.deepEqual(recorder.events.map((event) => event.topic), [
    'model-service.catalog.changed',
    'model-service.catalog.changed',
    'model-service.catalog.changed',
  ]);
  const payloads = recorder.events.map((event) => event.payload as { revision: number; reason: string; catalog: unknown });
  assert.deepEqual(payloads.map((payload) => ({ revision: payload.revision, reason: payload.reason })), [
    { revision: 1, reason: 'provider-saved' },
    { revision: 2, reason: 'credential-reset' },
    { revision: 3, reason: 'provider-deleted' },
  ]);
  assert.deepEqual(payloads[0]?.catalog, {
    models: [{ id: 'broadcast-model', name: 'broadcast-model' }],
    defaultModel: 'broadcast-model',
  });
  assert.deepEqual(payloads[1]?.catalog, {
    models: [{ id: 'broadcast-model', name: 'broadcast-model' }],
    defaultModel: 'broadcast-model',
    configurationError: { code: 'MISSING_CREDENTIAL', message: '模型服务未配置凭据' },
  });
  assert.deepEqual(payloads[2]?.catalog, { models: [], defaultModel: '', configurationError: { code: 'MISSING_BASE_URL', message: '模型服务未配置 Provider 地址' } });
  assert.doesNotMatch(JSON.stringify(recorder.events), /fake-secret-never-returned|credential-broadcast|credentialId|token/iu);
});

test('凭据或配置持久化失败时不广播 Catalog 变更', async () => {
  const recorder = makeBroadcastRecorder();
  const failingConfig: ConfigReader = {
    get<T>(key: string): T | undefined { return key === 'service' ? { providers: [] } as T : undefined; },
    set() { throw new Error('config write failed'); },
  };
  const service = new ModelService({
    config: failingConfig,
    credentials: { async get(id) { return { profile: { id }, secret }; }, async put(value) { return { id: value.id || 'credential-failed-write' }; } },
    message: recorder.message,
  });
  await assert.rejects(service.saveProvider({ id: 'failed-write', baseUrl: 'https://failed.invalid', models: [{ id: 'm' }], secret }));
  assert.equal(recorder.events.length, 0);
});

test('广播 Catalog 会按 Vault 实际读取结果报告失效凭据', async () => {
  const harness = makeDraftHarness();
  const recorder = makeBroadcastRecorder();
  const service = new ModelService({
    config: harness.config,
    credentials: {
      async get() { throw new Error('credential is locked'); },
      async put(value) { return { id: value.id || 'credential-locked' }; },
    },
    message: recorder.message,
  });
  await service.saveProvider({ id: 'locked-provider', baseUrl: 'https://locked.invalid', models: [{ id: 'm' }], secret });
  const payload = recorder.events[0]?.payload as { catalog: { configurationError?: { code: string } } };
  assert.equal(payload.catalog.configurationError?.code, 'MISSING_CREDENTIAL');
});

test('重置空 credentialId 幂等且不会调用 Vault 删除', async () => {
  const provider = makeProvider({ id: 'empty-provider', credentialId: '' });
  const harness = makeDraftHarness();
  harness.config.set?.('service', { providers: [provider], defaultProviderId: provider.id }, 'global');
  let deleteCalls = 0;
  const service = new ModelService({ config: harness.config, credentials: { async get(id) { return { profile: { id }, secret }; }, async delete() { deleteCalls += 1; } } });
  await service.resetProviderCredential({ providerId: 'empty-provider' });
  await service.resetProviderCredential({ providerId: 'empty-provider' });
  assert.equal(deleteCalls, 0);
  assert.equal(harness.read().providers[0]?.credentialId, '');
});

test('Vault 删除失败时保留 credentialId 且不泄漏底层错误', async () => {
  const provider = makeProvider({ id: 'failed-reset', credentialId: 'credential-failed' });
  const harness = makeDraftHarness();
  harness.config.set?.('service', { providers: [provider], defaultProviderId: provider.id }, 'global');
  const service = new ModelService({ config: harness.config, credentials: { async get(id) { return { profile: { id }, secret }; }, async delete() { throw new Error(`vault failure ${secret}`); } } });
  await assert.rejects(service.resetProviderCredential({ providerId: 'failed-reset' }), (error: any) => {
    assert.equal(error.code, 'MODEL_SERVICE_NOT_CONFIGURED');
    assert.doesNotMatch(String(error), /vault failure|fake-secret-never-returned/u);
    return true;
  });
  assert.equal(harness.read().providers[0]?.credentialId, 'credential-failed');
});

test('传入外部 env 或 DSH 路径不会覆盖绑定 Config 和 Credential Vault', async () => {
  let authorization = '';
  const provider = makeProvider({ baseUrl: 'https://bound.invalid' });
  const names = ['HARBORS_RELAY_API_KEY', 'PI_AGENT_API_KEY', 'HARBORS_DSH_SETTINGS_PATH', 'HARBORS_DSH_CREDENTIALS_PATH'] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]])) as Record<string, string | undefined>;
  process.env.HARBORS_RELAY_API_KEY = 'wrong-env-secret';
  process.env.PI_AGENT_API_KEY = 'wrong-pi-secret';
  process.env.HARBORS_DSH_SETTINGS_PATH = '/tmp/.dsh/settings.yaml';
  process.env.HARBORS_DSH_CREDENTIALS_PATH = '/tmp/.dsh/credentials.yaml';
  try {
    const service = new ModelService({
      config: makeConfig(provider),
      credentials: makeCredentials({ secret }),
      fetch: async (_url, init) => { authorization = (init?.headers as Record<string, string>).authorization; return response({ choices: [{ message: { content: 'ok' } }] }); },
    });
    await service.complete(input);
    assert.equal(authorization, `Bearer ${secret}`);
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('webSearch resolves its token only inside Model Service', async () => {
  let seen: RequestInit | undefined;
  const provider = makeProvider({ protocol: 'anthropic-messages', models: [{ id: 'test-model', name: 'Test Model', webSearch: true }] });
  const service = makeService(async (_url, init) => { seen = init; return response({ content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', title: 'Result', url: 'https://example.invalid', snippet: 'summary' }] }] }); }, provider);
  const result = await service.webSearch({ requestId: 'search-1', query: 'query' });
  assert.match(result.result, /example\.invalid/u);
  assert.equal((seen?.headers as Record<string, string>)['x-api-key'], secret);
  assert.doesNotMatch(result.result, new RegExp(secret, 'u'));
});

test('webSearch 拒绝字符串 legacy 请求且不读取凭据或调用 fetch', async () => {
  let credentialReads = 0;
  let fetchCalls = 0;
  const service = new ModelService({
    config: makeConfig(makeProvider({ protocol: 'anthropic-messages', models: [{ id: 'test-model', name: 'Test Model', webSearch: true }] })),
    credentials: { async get(id) { credentialReads += 1; return { profile: { id }, secret }; } },
    fetch: async () => { fetchCalls += 1; return response({}); },
  });
  await assert.rejects(service.webSearch('query' as unknown as { requestId: string; query: string }), (error: any) => error.code === 'INVALID_INPUT' && error.requestId === '');
  assert.equal(credentialReads, 0);
  assert.equal(fetchCalls, 0);
});

test('高成本路由 manifest 只接受 Agent caller', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { ['ce-editor']: { contribute: { message: { request: Record<string, unknown> } } } };
  const request = manifest['ce-editor'].contribute.message.request;
  assert.deepEqual(request.complete, { methods: ['complete'], callers: ['agent'] });
  assert.deepEqual(request.cancel, { methods: ['cancel'], callers: ['agent'] });
  assert.deepEqual(request.webSearch, { methods: ['webSearch'], callers: ['agent'] });
  assert.deepEqual(request.getCatalog, ['getCatalog']);
});

test('能力不支持时在读取凭据和 fetch 前拒绝，并返回安全 envelope', async () => {
  let credentialReads = 0;
  let fetchCalls = 0;
  const provider = makeProvider({ models: [{ id: 'test-model', name: 'Test', reasoningEfforts: ['low'] }] });
  const service = new ModelService({
    config: makeConfig(provider),
    credentials: { async get(id) { credentialReads += 1; return { profile: { id }, secret }; } },
    fetch: async () => { fetchCalls += 1; return response({ choices: [{ message: { content: 'no' } }] }); },
  });
  await assert.rejects(service.complete({ ...input, requestId: 'unsupported-before-io', reasoningEffort: 'high' }), (error: any) => {
    assert.deepEqual(error.envelope(), { code: 'UNSUPPORTED_CAPABILITY', message: '当前模型不支持该 reasoning effort', retryable: false, requestId: 'unsupported-before-io' });
    assert.deepEqual(JSON.parse(JSON.stringify(error)), error.envelope());
    return true;
  });
  assert.equal(credentialReads, 0);
  assert.equal(fetchCalls, 0);
});

test('Anthropic webSearch 使用结构化 requestId 并共享取消终态', async () => {
  const provider = makeProvider({ protocol: 'anthropic-messages', models: [{ id: 'test-model', name: 'Test', webSearch: true }] });
  let release!: (value: Response) => void;
  const pending = new Promise<Response>((resolve) => { release = resolve; });
  const service = makeService(async () => pending, provider);
  const search = service.webSearch({ requestId: 'search-cancel', query: 'query' });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(service.cancel({ requestId: 'search-cancel' }), { requestId: 'search-cancel', state: 'cancelled' });
  release(response({ content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', title: 'late', url: 'https://example.invalid' }] }] }));
  await assert.rejects(search, (error: any) => error.code === 'MODEL_SERVICE_CANCELLED' && error.requestId === 'search-cancel');
  assert.deepEqual(service.cancel({ requestId: 'search-cancel' }), { requestId: 'search-cancel', state: 'already_cancelled' });
});

test('请求 timeout 以毫秒计并固定 timed_out 终态', async () => {
  const service = new ModelService({ config: makeConfig(), credentials: makeCredentials(), requestTimeoutMs: 5, fetch: async () => new Promise<Response>(() => {}) });
  await assert.rejects(service.complete({ ...input, requestId: 'timeout-terminal' }), (error: any) => error.code === 'MODEL_SERVICE_TIMEOUT' && error.requestId === 'timeout-terminal');
  assert.deepEqual(service.cancel({ requestId: 'timeout-terminal' }), { requestId: 'timeout-terminal', state: 'timed_out' });
});

test('Catalog 只暴露 provider 与 adapter 的能力交集', async () => {
  const anthropic = makeProvider({ protocol: 'anthropic-messages', models: [{ id: 'test-model', name: 'Test', reasoningEfforts: ['low'], serviceTiers: ['fast'], webSearch: true }] });
  const catalog = await makeService(async () => response({}), anthropic).getCatalog();
  assert.equal(catalog.models[0]?.webSearch, true);
  assert.equal('reasoningEfforts' in (catalog.models[0] || {}), false);
  assert.equal('serviceTiers' in (catalog.models[0] || {}), false);
});

test('complete 和 webSearch 拒绝复用 terminal requestId，且不触发新的 IO', async () => {
  let credentialReads = 0;
  let fetchCalls = 0;
  const provider = makeProvider({ protocol: 'anthropic-messages', models: [{ id: 'test-model', name: 'Test Model', webSearch: true }] });
  const service = new ModelService({
    config: makeConfig(provider),
    credentials: { async get(id) { credentialReads += 1; return { profile: { id }, secret }; } },
    fetch: async (_url, init) => { fetchCalls += 1; const body = JSON.parse(String(init?.body)); return body.tools ? response({ content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', title: 'Result', url: 'https://example.invalid' }] }] }) : response({ content: [{ type: 'text', text: 'ok' }] }); },
  });
  await service.complete({ ...input, requestId: 'reused-complete' });
  const readsAfterComplete = credentialReads;
  const fetchesAfterComplete = fetchCalls;
  await assert.rejects(service.complete({ ...input, requestId: 'reused-complete' }), (error: any) => error.code === 'INVALID_INPUT' && error.requestId === 'reused-complete');
  assert.equal(credentialReads, readsAfterComplete);
  assert.equal(fetchCalls, fetchesAfterComplete);
  await service.webSearch({ requestId: 'reused-search', query: 'query' });
  const readsAfterSearch = credentialReads;
  const fetchesAfterSearch = fetchCalls;
  await assert.rejects(service.webSearch({ requestId: 'reused-search', query: 'query' }), (error: any) => error.code === 'INVALID_INPUT' && error.requestId === 'reused-search');
  assert.equal(credentialReads, readsAfterSearch);
  assert.equal(fetchCalls, fetchesAfterSearch);
});

test('OpenAI streaming fixture 逐段广播稳定 requestId/generation/sequence 并返回权威 complete', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const recorder = makeBroadcastRecorder();
  const service = new ModelService({
    config: makeConfig(makeProvider({ models: [{ id: 'test-model', name: 'Test Model', streaming: true }] })),
    credentials: makeCredentials(), message: recorder.message,
    fetch: async () => new Response(new ReadableStream({
      start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); },
    }), { headers: { 'content-type': 'text/event-stream' } }),
  });
  const result = await service.complete({ ...input, requestId: 'stream-1', generation: 'gen-1', stream: true });
  assert.equal(result.message.content, '你好');
  const deltas = recorder.events.filter((event) => event.topic === 'model-service.complete.delta').map((event) => event.payload as { requestId: string; generation: string; sequence: number; delta: { text: string } });
  assert.deepEqual(deltas.map((delta) => ({ requestId: delta.requestId, generation: delta.generation, sequence: delta.sequence, text: delta.delta.text })), [
    { requestId: 'stream-1', generation: 'gen-1', sequence: 0, text: '你' },
    { requestId: 'stream-1', generation: 'gen-1', sequence: 1, text: '好' },
  ]);
  assert.equal((recorder.events.at(-1)?.payload as { state: string }).state, 'completed');
});

test('Anthropic SSE fixture 遵循 event framing，忽略 event/id/retry 并合并多行 data', async () => {
  const chunks = [
    'event: message_start\nid: anthropic-1\nretry: 1000\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {\ndata: "type": "content_block_delta",\ndata: "index": 0,\ndata: "delta": {"text": "你"}\ndata: }\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"text":"好"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2}}\n\n',
    'event: message_stop\nid: anthropic-2\ndata: [DONE]\n\n',
  ];
  const recorder = makeBroadcastRecorder();
  const service = new ModelService({
    config: makeConfig(makeProvider({ protocol: 'anthropic-messages', models: [{ id: 'test-model', name: 'Test Model', streaming: true }] })),
    credentials: makeCredentials(), message: recorder.message,
    fetch: async () => new Response(new ReadableStream({
      start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); },
    }), { headers: { 'content-type': 'text/event-stream' } }),
  });
  const result = await service.complete({ ...input, requestId: 'anthropic-stream-1', generation: 'gen-anthropic', stream: true });
  assert.equal(result.message.content, '你好');
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 2, totalTokens: 5 });
  const deltas = recorder.events.filter((event) => event.topic === 'model-service.complete.delta').map((event) => (event.payload as any).delta.text);
  assert.deepEqual(deltas, ['你', '好']);
});

test('流式 SSE 单事件超过有限帧缓存时返回稳定错误并取消 reader', async () => {
  let readerCancelled = false;
  const oversized = `data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(300_000) } }] })}\n\n`;
  const service = new ModelService({
    config: makeConfig(makeProvider({ models: [{ id: 'test-model', name: 'Test Model', streaming: true }] })),
    credentials: makeCredentials(),
    fetch: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(oversized)); },
      cancel() { readerCancelled = true; },
    }), { headers: { 'content-type': 'text/event-stream' } }),
  });
  await assert.rejects(service.complete({ ...input, requestId: 'stream-limit', stream: true }), (error: any) => {
    assert.equal(error.code, 'MODEL_SERVICE_INVALID_RESPONSE');
    assert.match(error.message, /大小上限/u);
    return true;
  });
  assert.equal(readerCancelled, true);
});

test('Provider 不支持 streaming 时走一次非流式兼容完成，不伪造 delta', async () => {
  const recorder = makeBroadcastRecorder();
  const service = new ModelService({
    config: makeConfig(makeProvider({ models: [{ id: 'test-model', name: 'Test Model', streaming: false }] })),
    credentials: makeCredentials(), message: recorder.message,
    fetch: async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).stream, false);
      return response({ choices: [{ message: { content: '兼容' } }] });
    },
  });
  const result = await service.complete({ ...input, requestId: 'fallback-1', stream: true });
  assert.equal(result.message.content, '兼容');
  assert.equal(recorder.events.filter((event) => event.topic === 'model-service.complete.delta').length, 0);
});

test('streaming reader 收到 cancel 后停止读取并丢弃晚到 chunk，取消幂等', async () => {
  const recorder = makeBroadcastRecorder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const service = new ModelService({
    config: makeConfig(makeProvider({ models: [{ id: 'test-model', name: 'Test Model', streaming: true }] })),
    credentials: makeCredentials(), message: recorder.message,
    fetch: async () => new Response(new ReadableStream({ start(next) { controller = next; next.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"先"}}]}\n\n')); } }), { headers: { 'content-type': 'text/event-stream' } }),
  });
  const completion = service.complete({ ...input, requestId: 'stream-cancel', generation: 'gen-cancel', stream: true });
  while (recorder.events.filter((event) => event.topic === 'model-service.complete.delta').length < 1) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(service.cancel({ requestId: 'stream-cancel' }), { requestId: 'stream-cancel', state: 'cancelled' });
  assert.deepEqual(service.cancel({ requestId: 'stream-cancel' }), { requestId: 'stream-cancel', state: 'already_cancelled' });
  try { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"晚"}}]}\n\n')); } catch { /* reader cancellation closes the fixture */ }
  await assert.rejects(completion, (error: any) => error.code === 'MODEL_SERVICE_CANCELLED');
  assert.equal(recorder.events.filter((event) => event.topic === 'model-service.complete.delta').length, 1);
});
