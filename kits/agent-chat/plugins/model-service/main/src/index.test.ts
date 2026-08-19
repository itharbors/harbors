import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ModelService } from './index.js';
import { buildRequest } from './protocol.js';
import type { CompleteInput } from './types.js';

const input: CompleteInput = { requestId: 'r-1', purpose: 'turn', messages: [{ role: 'user', content: 'hello' }] };
const response = (body: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(body), { status, headers });

test('catalog respects environment priority and does not expose credential metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-service-'));
  const settings = join(dir, 'settings.yaml');
  await writeFile(settings, '    relay:\n      baseURL: https://dsh.invalid\n      apiKeyEnv: DSH_SECRET\n      api: anthropic-messages\n      - id: dsh-model\n        name: DSH\n    agent-default-model:\n      provider: relay\n      model: dsh-model\n');
  try {
    const service = new ModelService({ env: { HARBORS_DSH_SETTINGS_PATH: settings, DSH_SECRET: 'secret', HARBORS_RELAY_BASE_URL: 'https://env.invalid', HARBORS_RELAY_API_KEY: 'env-secret', HARBORS_RELAY_MODEL: 'env-model', HARBORS_RELAY_CONTEXT_WINDOW: '321' } });
    const catalog = await service.getCatalog();
    assert.equal(catalog.defaultModel, 'dsh-model');
    assert.equal(catalog.models[0]?.id, 'dsh-model');
    assert.equal(catalog.models[0]?.contextWindow, 321);
    assert.doesNotMatch(JSON.stringify(catalog), /secret|DSH_SECRET|settings\.yaml/u);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('catalog reports stable configuration errors', async () => {
  const missingBase = await new ModelService({ env: { HARBORS_DSH_SETTINGS_PATH: join(tmpdir(), 'missing-model-service-settings.yaml') } }).getCatalog();
  assert.equal(missingBase.configurationError?.code, 'MISSING_BASE_URL');
  const missingCredential = await new ModelService({ env: { HARBORS_DSH_SETTINGS_PATH: join(tmpdir(), 'missing-model-service-settings.yaml'), HARBORS_RELAY_BASE_URL: 'https://relay.invalid' } }).getCatalog();
  assert.equal(missingCredential.configurationError?.code, 'MISSING_CREDENTIAL');
});

test('legacy model environment is used for fallback model and context window', async () => {
  const catalog = await new ModelService({ env: { HARBORS_DSH_SETTINGS_PATH: join(tmpdir(), 'missing-model-service-settings.yaml'), HARBORS_RELAY_MODEL: 'env-model', HARBORS_RELAY_CONTEXT_WINDOW: '777' } }).getCatalog();
  assert.equal(catalog.defaultModel, 'env-model');
  assert.equal(catalog.models[0]?.id, 'env-model');
  assert.equal(catalog.models[0]?.contextWindow, 777);
});

test('unsafe DSH credential files fail without leaking path, ref, or secret', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-service-'));
  const settings = join(dir, 'settings.yaml');
  const credentials = join(dir, 'credentials.yaml');
  const ref = 'MODEL_SERVICE_TEST_SECRET';
  const secret = 'not-returned-secret';
  await writeFile(settings, `    relay:\n      baseURL: https://relay.invalid\n      apiKeyEnv: ${ref}\n`);
  await writeFile(credentials, `${ref}: ${secret}\n`);
  await chmod(credentials, 0o644);
  try {
    await assert.rejects(new ModelService({ env: { HARBORS_DSH_SETTINGS_PATH: settings, HARBORS_DSH_CREDENTIALS_PATH: credentials } }).getCatalog(), (error: any) => {
      assert.equal(error.code, 'MODEL_SERVICE_NOT_CONFIGURED');
      assert.doesNotMatch(String(error), new RegExp(credentials.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
      assert.doesNotMatch(String(error), new RegExp(ref, 'u'));
      assert.doesNotMatch(String(error), new RegExp(secret, 'u'));
      return true;
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('builds OpenAI payload and normalizes tool calls and usage', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const service = new ModelService({ env: { HARBORS_DSH_SETTINGS_PATH: join(tmpdir(), 'missing-model-service-settings.yaml'), HARBORS_RELAY_BASE_URL: 'https://relay.invalid', HARBORS_RELAY_API_KEY: 'secret', HARBORS_RELAY_MODEL: 'gpt' }, fetch: async (url, init) => { seen = { url: String(url), init }; return response({ choices: [{ message: { content: 'ok', tool_calls: [{ id: 'call-1', function: { name: 'read', arguments: '{"path":"a"}' } }] } }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } }); } });
  const result = await service.complete({ ...input, tools: [{ name: 'read', description: 'read', inputSchema: { type: 'object' } }] });
  const body = JSON.parse(String(seen!.init.body));
  assert.equal(seen!.url, 'https://relay.invalid/chat/completions');
  assert.equal(body.tools[0].function.name, 'read');
  assert.equal(result.message.toolCalls?.[0]?.arguments, '{"path":"a"}');
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 4, totalTokens: 16 });
});

test('builds Anthropic payload with image and normalizes text/tool use', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const service = new ModelService({ env: { HARBORS_DSH_SETTINGS_PATH: join(tmpdir(), 'missing-model-service-settings.yaml'), HARBORS_RELAY_BASE_URL: 'https://relay.invalid/', HARBORS_RELAY_API_KEY: 'secret', HARBORS_RELAY_API: 'anthropic-messages', HARBORS_RELAY_MODEL: 'claude' }, fetch: async (url, init) => { seen = { url: String(url), init }; return response({ content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'call-1', name: 'read', input: { path: 'a' } }], usage: { input_tokens: 10, output_tokens: 3 } }); } });
  const result = await service.complete({ ...input, system: 'system', messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', mediaType: 'image/png', data: 'AA==' }] }] });
  const body = JSON.parse(String(seen!.init.body));
  assert.equal(seen!.url, 'https://relay.invalid/v1/messages');
  assert.equal(body.system, 'system');
  assert.equal(body.messages[0].content[1].source.data, 'AA==');
  assert.equal(result.message.toolCalls?.[0]?.name, 'read');
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 3, totalTokens: 13 });
});

test('retries transient errors and supports disabled retries', async () => {
  let calls = 0;
  const service = new ModelService({ env: { HARBORS_DSH_SETTINGS_PATH: join(tmpdir(), 'missing-model-service-settings.yaml'), HARBORS_RELAY_BASE_URL: 'https://relay.invalid', HARBORS_RELAY_API_KEY: 'secret', HARBORS_RELAY_RETRY_BASE_DELAY_MS: '0' }, fetch: async () => { calls += 1; return calls === 1 ? response({ error: 'busy' }, 503) : response({ choices: [{ message: { content: 'ok' } }] }); } });
  await service.complete(input);
  assert.equal(calls, 2);
  const disabled = new ModelService({ env: { HARBORS_DSH_SETTINGS_PATH: join(tmpdir(), 'missing-model-service-settings.yaml'), HARBORS_RELAY_BASE_URL: 'https://relay.invalid', HARBORS_RELAY_API_KEY: 'secret' }, fetch: async () => response({ error: 'busy' }, 503) });
  await assert.rejects(disabled.complete({ ...input, requestId: 'r-disabled', retryMode: 'disabled' }), (error: any) => error.code === 'MODEL_SERVICE_HTTP_ERROR');
});

test('cancel, unload, and context overflow expose stable error codes', async () => {
  let release!: () => void;
  const pending = new Promise<Response>((resolve) => { release = () => resolve(response({ choices: [{ message: { content: 'late' } }] })); });
  const service = new ModelService({ env: { HARBORS_DSH_SETTINGS_PATH: join(tmpdir(), 'missing-model-service-settings.yaml'), HARBORS_RELAY_BASE_URL: 'https://relay.invalid', HARBORS_RELAY_API_KEY: 'secret' }, fetch: async () => pending });
  const completion = service.complete(input);
  assert.deepEqual(service.cancel('r-1'), { requestId: 'r-1', state: 'cancelled' });
  release();
  await assert.rejects(completion, (error: any) => error.code === 'MODEL_SERVICE_CANCELLED');
  assert.deepEqual(service.cancel('r-1'), { requestId: 'r-1', state: 'completed' });
  const overflow = new ModelService({ env: { HARBORS_DSH_SETTINGS_PATH: join(tmpdir(), 'missing-model-service-settings.yaml'), HARBORS_RELAY_BASE_URL: 'https://relay.invalid', HARBORS_RELAY_API_KEY: 'secret' }, fetch: async () => response({ error: 'maximum context length exceeded' }, 400) });
  await assert.rejects(overflow.complete({ ...input, requestId: 'overflow' }), (error: any) => error.code === 'MODEL_SERVICE_CONTEXT_OVERFLOW');
  const stopped = new ModelService({ env: { HARBORS_DSH_SETTINGS_PATH: join(tmpdir(), 'missing-model-service-settings.yaml'), HARBORS_RELAY_BASE_URL: 'https://relay.invalid', HARBORS_RELAY_API_KEY: 'secret' }, fetch: async () => pending });
  const stoppedCompletion = stopped.complete({ ...input, requestId: 'stopped' });
  stopped.unload();
  await assert.rejects(stoppedCompletion, (error: any) => error.code === 'MODEL_SERVICE_STOPPED');
});

test('context overflow detection is limited to 413 and matching 400 responses', async () => {
  const env = { HARBORS_DSH_SETTINGS_PATH: join(tmpdir(), 'missing-model-service-settings.yaml'), HARBORS_RELAY_BASE_URL: 'https://relay.invalid', HARBORS_RELAY_API_KEY: 'secret', HARBORS_RELAY_RETRY_ENABLED: 'false' };
  const serverError = new ModelService({ env, fetch: async () => response({ error: 'context backend unavailable' }, 500) });
  await assert.rejects(serverError.complete({ ...input, requestId: 'server-context' }), (error: any) => error.code === 'MODEL_SERVICE_HTTP_ERROR');
  const payloadError = new ModelService({ env, fetch: async () => response({ error: 'invalid request' }, 400) });
  await assert.rejects(payloadError.complete({ ...input, requestId: 'bad-request' }), (error: any) => error.code === 'MODEL_SERVICE_HTTP_ERROR');
  const tooLarge = new ModelService({ env, fetch: async () => response({ error: 'request exceeds context token limit' }, 400) });
  await assert.rejects(tooLarge.complete({ ...input, requestId: 'too-large' }), (error: any) => error.code === 'MODEL_SERVICE_CONTEXT_OVERFLOW');
});

test('protocol keeps headers private and emits both endpoint shapes', () => {
  const config = { baseUrl: 'https://relay.invalid', credential: 'secret', api: 'openai-completions', modelId: 'm', models: [], retry: { enabled: true, maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } };
  const plan = buildRequest(config, input, 'm');
  assert.equal(plan.init.headers && (plan.init.headers as Record<string, string>).authorization, 'Bearer secret');
  const anthropicPlan = buildRequest({ ...config, api: 'anthropic-messages' }, { ...input, messages: [{ role: 'tool', toolCallId: 'call-1', isError: true, content: 'failed' }] }, 'm');
  const anthropicBody = JSON.parse(String(anthropicPlan.init.body));
  assert.equal(anthropicBody.messages[0].content[0].is_error, true);
  const imageToolPlan = buildRequest(config, { ...input, messages: [{ role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'result' }, { type: 'image', mediaType: 'image/png', data: 'AA==' }] }] }, 'm');
  const imageToolBody = JSON.parse(String(imageToolPlan.init.body));
  assert.equal(imageToolBody.messages.length, 2);
  assert.equal(imageToolBody.messages[0].role, 'tool');
  assert.equal(imageToolBody.messages[0].content, 'result');
  assert.equal(imageToolBody.messages[1].role, 'user');
  assert.equal(imageToolBody.messages[1].content[1].type, 'image_url');
  const plainToolPlan = buildRequest(config, { ...input, messages: [{ role: 'tool', toolCallId: 'call-1', content: 'result' }] }, 'm');
  const plainToolBody = JSON.parse(String(plainToolPlan.init.body));
  assert.equal(plainToolBody.messages.length, 1);
});

test('uses the complete stable error-code set', async () => {
  const env = { HARBORS_DSH_SETTINGS_PATH: join(tmpdir(), 'missing-model-service-settings.yaml'), HARBORS_RELAY_BASE_URL: 'https://relay.invalid', HARBORS_RELAY_API_KEY: 'secret' };
  const cases: Array<[string, () => Promise<unknown>]> = [
    ['MODEL_SERVICE_NOT_CONFIGURED', () => new ModelService({ env: { HARBORS_DSH_SETTINGS_PATH: env.HARBORS_DSH_SETTINGS_PATH } }).complete({ ...input, requestId: 'not-configured' })],
    ['MODEL_SERVICE_UNSUPPORTED_API', () => new ModelService({ env: { ...env, HARBORS_RELAY_API: 'unknown' } }).complete({ ...input, requestId: 'unsupported' })],
    ['MODEL_SERVICE_INVALID_RESPONSE', () => new ModelService({ env, fetch: async () => response({ choices: [] }) }).complete({ ...input, requestId: 'invalid' })],
    ['MODEL_SERVICE_NETWORK_ERROR', () => new ModelService({ env, fetch: async () => { throw new TypeError('offline'); } }).complete({ ...input, requestId: 'network' })],
    ['MODEL_SERVICE_TIMEOUT', () => new ModelService({ env, requestTimeoutMs: 1, fetch: async () => new Promise<Response>(() => {}) }).complete({ ...input, requestId: 'timeout' })],
  ];
  for (const [code, request] of cases) await assert.rejects(request(), (error: any) => error.code === code);
});
