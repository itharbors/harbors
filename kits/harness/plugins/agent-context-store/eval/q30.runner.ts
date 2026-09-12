import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ContextStore } from '../main/src/store.js';
import type { BuildContextOutput, NeutralMessage } from '../main/src/types.js';
import { loadQ30Fixture, scoreAnswer, type ProviderAnswer, type Q30Case } from './q30-contract.js';

type Variant = 'current' | 'candidate';

type ProviderConfig =
  | { transport: 'direct'; endpoint: string; model: string; apiKey?: string }
  | { transport: 'harbors-message'; baseUrl: string; sessionId: string; panelCapability: string; model: string };

function providerConfig(): ProviderConfig | undefined {
  const baseUrl = process.env.HARBORS_Q30_HARBORS_URL?.trim().replace(/\/$/u, '');
  const sessionId = process.env.HARBORS_Q30_SESSION_ID?.trim();
  const panelCapability = process.env.HARBORS_Q30_PANEL_CAPABILITY?.trim();
  const model = process.env.HARBORS_Q30_MODEL?.trim();
  if (baseUrl && sessionId && panelCapability && model) return { transport: 'harbors-message', baseUrl, sessionId, panelCapability, model };
  const endpoint = process.env.HARBORS_Q30_ENDPOINT?.trim();
  if (!endpoint || !model) return undefined;
  const apiKey = process.env.HARBORS_Q30_API_KEY?.trim();
  return { transport: 'direct', endpoint, model, ...(apiKey ? { apiKey } : {}) };
}

function conversation(id: string) {
  const now = new Date(0).toISOString();
  return { id, title: 'Q30', sandboxMode: 'read-only' as const, approvalPolicy: 'ask' as const, createdAt: now, updatedAt: now };
}

async function contexts(testCase: Q30Case): Promise<Record<Variant, BuildContextOutput>> {
  const directory = await mkdtemp(join(tmpdir(), 'harbors-q30-'));
  const store = new ContextStore(directory);
  try {
    const numericId = Number(testCase.id.slice(1));
    const conversationId = `00000000-0000-4000-8000-${String(numericId).padStart(12, '0')}`;
    store.createConversation(conversation(conversationId));
    for (const [index, content] of testCase.turns.entries()) {
      store.appendEvent({
        conversationId,
        idempotencyKey: `${testCase.id}:${index + 1}`,
        event: { type: 'user/message', time: index + 1, data: { turn: index + 1, content, message: { role: 'user', content } }, surfaceOp: 'append' },
      });
    }
    // Q30 isolates Context assembly quality. The deterministic state reducer is
    // seeded with the expected effective state; whether Agent accepts model
    // state-tool candidates is covered by the separate Agent integration tests.
    store.appendEvent({
      conversationId,
      idempotencyKey: `${testCase.id}:effective-state`,
      event: {
        type: 'state/set',
        time: testCase.turns.length + 1,
        data: { stateId: `${testCase.id}:effective`, kind: 'eval-effective-state', value: { state: testCase.expected.state, anchors: testCase.expected.anchors } },
      },
    });
    const input = { conversationId, turn: testCase.turns.length, step: 1, availableInputTokens: 800, budgetBreakdown: {} };
    return {
      current: store.buildContext({ ...input, mode: 'surface-v1' }),
      candidate: store.buildContext({ ...input, mode: 'candidate-v1' }),
    };
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function asText(messages: NeutralMessage[]): string {
  return messages.map((message, index) => `${index + 1}. ${message.role}: ${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}`).join('\n');
}

function stateType(value: unknown): string {
  if (Array.isArray(value)) return `${value.length > 0 ? stateType(value[0]) : 'unknown'}[]`;
  if (value === null) return 'null';
  return typeof value;
}

function parseAnswer(raw: string): ProviderAnswer {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  const answer = JSON.parse(trimmed) as ProviderAnswer;
  if (!answer || typeof answer !== 'object' || !answer.state || !Array.isArray(answer.recalledAnchors) || typeof answer.answer !== 'string') throw new Error('PROVIDER_ANSWER_INVALID');
  return answer;
}

function responseText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const text = content.filter((block): block is { type: 'text'; text: string } => !!block && typeof block === 'object' && (block as any).type === 'text' && typeof (block as any).text === 'string').map((block) => block.text).join('');
  return text || undefined;
}

async function callProvider(config: ProviderConfig, testCase: Q30Case, messages: NeutralMessage[]): Promise<{ answer: ProviderAnswer; latencyMs: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.HARBORS_Q30_TIMEOUT_MS || 60_000));
  const keyNames = Object.keys(testCase.expected.state);
  const stateShape = Object.entries(testCase.expected.state).map(([key, value]) => `${key}:${stateType(value)}`).join(', ');
  const prompt = [
    '你是对话状态抽取评测器。只根据给定上下文回答，不要补充上下文中不存在的信息。',
    '只保留最终仍有效的事实；已经取消、替换或否定的旧值不得写入 state 或 recalledAnchors。',
    `state 必须且只能包含这些键：${keyNames.join(', ')}。字段类型固定为：${stateShape}。`,
    '字符串值使用最终有效原文中的最短充分片段，不扩写；非数组字段不得改成数组。',
    '输出严格 JSON：{"state":{...},"recalledAnchors":["..."],"answer":"简短中文答案"}。',
    '',
    '上下文：',
    asText(messages),
  ].join('\n');
  const started = performance.now();
  try {
    const response = config.transport === 'direct'
      ? await fetch(config.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
        body: JSON.stringify({ model: config.model, temperature: 0, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' } }),
        signal: controller.signal,
      })
      : await fetch(`${config.baseUrl}/api/message/request?sessionId=${encodeURIComponent(config.sessionId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          plugin: 'model-service',
          name: 'complete',
          panelCapability: config.panelCapability,
          args: [{ requestId: `q30-${randomUUID()}`, purpose: 'turn', model: config.model, messages: [{ role: 'user', content: prompt }], maxOutputTokens: 800, retryMode: 'disabled', timeoutMs: Number(process.env.HARBORS_Q30_TIMEOUT_MS || 60_000), stream: false }],
        }),
        signal: controller.signal,
      });
    if (!response.ok) throw new Error(`PROVIDER_HTTP_${response.status}:${await response.text()}`);
    const payload = await response.json() as any;
    const raw = config.transport === 'direct'
      ? payload?.choices?.[0]?.message?.content
      : responseText(payload?.result?.message?.content);
    if (typeof raw !== 'string') throw new Error('PROVIDER_RESPONSE_INVALID');
    return { answer: parseAnswer(raw), latencyMs: performance.now() - started };
  } finally { clearTimeout(timeout); }
}

async function callProviderWithRetry(config: ProviderConfig, testCase: Q30Case, messages: NeutralMessage[]): Promise<{ answer: ProviderAnswer; latencyMs: number; attempts: number }> {
  const maxAttempts = Number(process.env.HARBORS_Q30_RETRY_ATTEMPTS || 3);
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error('HARBORS_Q30_RETRY_ATTEMPTS_INVALID');
  let lastError: unknown;
  for (let attempts = 1; attempts <= maxAttempts; attempts += 1) {
    try {
      return { ...await callProvider(config, testCase, messages), attempts };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function main(): Promise<void> {
  const config = providerConfig();
  if (!config) {
    process.stdout.write(`${JSON.stringify({ suite: 'Q30', status: 'skipped', reason: '设置 HARBORS_Q30_MODEL，并选择 HARBORS_Q30_ENDPOINT，或同时设置 HARBORS_Q30_HARBORS_URL、HARBORS_Q30_SESSION_ID 与 HARBORS_Q30_PANEL_CAPABILITY 后才会调用真实 Provider。' }, null, 2)}\n`);
    return;
  }
  const repeats = Number(process.env.HARBORS_Q30_REPEATS || 3);
  if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error('HARBORS_Q30_REPEATS_INVALID');
  const cases = await loadQ30Fixture();
  const fixtureDigest = createHash('sha256').update(JSON.stringify(cases)).digest('hex');
  const resumePath = process.env.HARBORS_Q30_RESUME?.trim();
  const previous = resumePath ? JSON.parse(await readFile(resumePath, 'utf8')) as any : undefined;
  if (previous && (previous.suite !== 'Q30' || previous.repeats !== repeats || previous.fixtureDigest !== fixtureDigest || !Array.isArray(previous.results))) throw new Error('HARBORS_Q30_RESUME_INVALID');
  const previousById = new Map<string, any>((previous?.results ?? []).map((item: any) => [item.id, item]));
  const results = [];
  for (const testCase of cases) {
    const built = await contexts(testCase);
    const variants: Record<Variant, unknown[]> = { current: [], candidate: [] };
    const previousCase = previousById.get(testCase.id);
    for (const variant of ['current', 'candidate'] as const) {
      for (let repeat = 1; repeat <= repeats; repeat += 1) {
        const previousRun = previousCase?.variants?.[variant]?.[repeat - 1];
        if (previousRun?.status === 'completed') {
          variants[variant].push(previousRun);
          continue;
        }
        try {
          const result = await callProviderWithRetry(config, testCase, built[variant].messages);
          variants[variant].push({ repeat, status: 'completed', latencyMs: result.latencyMs, attempts: result.attempts, ...scoreAnswer(testCase, result.answer), answer: result.answer });
        } catch (error) {
          variants[variant].push({ repeat, status: 'error', error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    results.push({
      id: testCase.id,
      category: testCase.category,
      expected: testCase.expected,
      contexts: Object.fromEntries((['current', 'candidate'] as const).map((variant) => [variant, built[variant]])),
      variants,
    });
  }
  const runs = (variant: Variant) => results.flatMap((item) => item.variants[variant] as any[]);
  const completed = (variant: Variant) => runs(variant).filter((item) => item.status === 'completed');
  const passed = (variant: Variant) => completed(variant).filter((item) => item.passed).length;
  const regressions = results.flatMap((item) => (item.variants.current as any[]).flatMap((current, index) => current.status === 'completed' && current.passed && !((item.variants.candidate as any[])[index]?.status === 'completed' && (item.variants.candidate as any[])[index]?.passed) ? [{ id: item.id, repeat: index + 1 }] : []));
  const expectedRuns = cases.length * repeats;
  const report = {
    suite: 'Q30', status: 'completed', generatedAt: new Date().toISOString(), fixtureDigest, repeats, resumed: Boolean(previous),
    provider: config.transport === 'direct' ? { transport: config.transport, endpoint: config.endpoint, model: config.model } : { transport: config.transport, baseUrl: config.baseUrl, model: config.model },
    summary: {
      current: { completed: completed('current').length, passed: passed('current') },
      candidate: { completed: completed('candidate').length, passed: passed('candidate') },
      regressions,
    },
    results,
  };
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.HARBORS_Q30_OUTPUT) await writeFile(process.env.HARBORS_Q30_OUTPUT, rendered, 'utf8');
  process.stdout.write(rendered);
  // Provider/解析错误按该变体失败计入真实基线。候选必须全部可评分；
  // 基线错误不应反过来阻止一个全量完成、且没有逐例回归的候选版本。
  if (completed('candidate').length !== expectedRuns || passed('candidate') < passed('current') || regressions.length > 0) process.exitCode = 1;
}

await main();
