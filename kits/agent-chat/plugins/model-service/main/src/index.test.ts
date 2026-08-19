import assert from 'node:assert/strict';
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

test('catalog uses bound config and hides credential metadata', async () => {
  const catalog = await makeService(async () => response({})).getCatalog();
  assert.equal(catalog.defaultModel, 'test-model');
  assert.equal(catalog.models[0]?.id, 'test-model');
  assert.doesNotMatch(JSON.stringify(catalog), /fake-secret|credential-1/u);
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
  assert.deepEqual(service.cancel('r-1'), { requestId: 'r-1', state: 'cancelled' });
  release();
  await assert.rejects(completion, (error: any) => error.code === 'MODEL_SERVICE_CANCELLED');
  assert.deepEqual(service.cancel('r-1'), { requestId: 'r-1', state: 'completed' });
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

test('逐字段保存允许先写地址再写 Token，调用前才要求完整配置', async () => {
  const harness = makeDraftHarness();
  const service = new ModelService({ config: harness.config, credentials: harness.credentials, fetch: async () => response({ choices: [{ message: { content: 'ok' } }] }) });
  await service.setSetting({ key: 'model-service.baseUrl', value: 'https://provider.invalid', layer: 'global' });
  assert.equal(harness.stored.length, 0);
  await service.setSetting({ key: 'model-service.secret', value: secret, layer: 'global' });
  assert.equal(harness.stored.length, 1);
  assert.equal(harness.read().providers[0]?.credentialId, 'credential-1');
  assert.equal((await service.complete(input)).message.content, 'ok');
});

test('逐字段保存允许先写 Token 再写地址，并保留已写入 credentialId', async () => {
  const harness = makeDraftHarness();
  const service = new ModelService({ config: harness.config, credentials: harness.credentials, fetch: async () => response({ choices: [{ message: { content: 'ok' } }] }) });
  await service.setSetting({ key: 'model-service.secret', value: secret, layer: 'global' });
  assert.equal(harness.stored.length, 1);
  assert.equal(harness.read().providers[0]?.baseUrl, '');
  await service.setSetting({ key: 'model-service.baseUrl', value: 'https://provider.invalid', layer: 'global' });
  assert.equal(harness.read().providers[0]?.credentialId, 'credential-1');
  assert.equal((await service.complete(input)).message.content, 'ok');
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
  await service.setSetting({ key: 'model-service.providerId', value: 'new-provider', layer: 'global' });
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

test('重置 Token 会先删除 Vault 凭据，再清空当前 Provider 的 credentialId', async () => {
  const provider = makeProvider({ id: 'reset-provider', credentialId: 'credential-reset' });
  const harness = makeDraftHarness();
  harness.config.set?.('service', { providers: [provider], defaultProviderId: provider.id }, 'global');
  let deleted = '';
  const service = new ModelService({ config: harness.config, credentials: { async get(id) { return { profile: { id }, secret }; }, async delete(id) { deleted = id; } } });
  await service.deleteSetting({ key: 'model-service.secret' });
  assert.equal(deleted, 'credential-reset');
  assert.equal(harness.read().providers[0]?.credentialId, '');
  assert.equal(harness.read().providers[0]?.baseUrl, provider.baseUrl);
});

test('重置空 credentialId 幂等且不会调用 Vault 删除', async () => {
  const provider = makeProvider({ id: 'empty-provider', credentialId: '' });
  const harness = makeDraftHarness();
  harness.config.set?.('service', { providers: [provider], defaultProviderId: provider.id }, 'global');
  let deleteCalls = 0;
  const service = new ModelService({ config: harness.config, credentials: { async get(id) { return { profile: { id }, secret }; }, async delete() { deleteCalls += 1; } } });
  await service.deleteSetting({ key: 'model-service.secret' });
  await service.deleteSetting({ key: 'model-service.secret' });
  assert.equal(deleteCalls, 0);
  assert.equal(harness.read().providers[0]?.credentialId, '');
});

test('Vault 删除失败时保留 credentialId 且不泄漏底层错误', async () => {
  const provider = makeProvider({ id: 'failed-reset', credentialId: 'credential-failed' });
  const harness = makeDraftHarness();
  harness.config.set?.('service', { providers: [provider], defaultProviderId: provider.id }, 'global');
  const service = new ModelService({ config: harness.config, credentials: { async get(id) { return { profile: { id }, secret }; }, async delete() { throw new Error(`vault failure ${secret}`); } } });
  await assert.rejects(service.deleteSetting({ key: 'model-service.secret' }), (error: any) => {
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
  const service = makeService(async (_url, init) => { seen = init; return response({ content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', title: 'Result', url: 'https://example.invalid', snippet: 'summary' }] }] }); });
  const result = await service.webSearch('query');
  assert.match(result, /example\.invalid/u);
  assert.equal((seen?.headers as Record<string, string>)['x-api-key'], secret);
  assert.doesNotMatch(result, new RegExp(secret, 'u'));
});
