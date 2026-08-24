import type { RelayConfig } from './config.js';
import { ModelServiceError } from './types.js';
import type { CompleteInput, ContentBlock, ModelCatalogEntry, ModelTool, NeutralMessage, NeutralToolCall, NormalizedUsage } from './types.js';

export interface RequestPlan { url: string; init: RequestInit; model: string; }

export function buildRequest(config: RelayConfig, input: CompleteInput, model: string): RequestPlan {
  validateCapabilities(config, input);
  if (config.api === 'openai-completions') {
    const messages = openAiMessages(input.messages, input.system);
    const body: Record<string, unknown> = { model, stream: input.stream === true, messages };
    if (input.tools?.length) body.tools = input.tools.map(openAiTool);
    if (input.maxOutputTokens !== undefined) body.max_tokens = input.maxOutputTokens;
    addOpenAiOptions(body, config, input);
    return {
      url: `${config.baseUrl}/chat/completions`,
      init: { method: 'POST', headers: { authorization: `Bearer ${config.credential}`, 'content-type': 'application/json' }, body: JSON.stringify(body) },
      model,
    };
  }
  if (config.api === 'anthropic-messages') {
    const body: Record<string, unknown> = {
      model,
      max_tokens: input.maxOutputTokens ?? 16_384,
      ...(input.stream === true ? { stream: true } : {}),
      messages: anthropicMessages(input.messages),
    };
    if (input.system) body.system = input.system;
    if (input.tools?.length) body.tools = input.tools.map(anthropicTool);
    return {
      url: `${config.baseUrl}/v1/messages`,
      init: { method: 'POST', headers: { 'x-api-key': config.credential, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify(body) },
      model,
    };
  }
  throw new ModelServiceError('MODEL_SERVICE_UNSUPPORTED_API', '模型服务配置使用了不支持的 API 协议');
}

export function effectiveModelCapabilities(model: ModelCatalogEntry | undefined, api: RelayConfig['api']): ModelCatalogEntry | undefined {
  if (!model) return undefined;
  const openAi = api === 'openai-completions';
  const { reasoningEfforts, serviceTiers, defaultReasoningEffort, defaultServiceTier, webSearch, ...base } = model;
  return {
    ...base,
    ...(openAi && reasoningEfforts ? { reasoningEfforts: [...reasoningEfforts] } : {}),
    ...(openAi && serviceTiers ? { serviceTiers: [...serviceTiers] } : {}),
    ...(openAi && defaultReasoningEffort && reasoningEfforts?.includes(defaultReasoningEffort) ? { defaultReasoningEffort } : {}),
    ...(openAi && defaultServiceTier && serviceTiers?.includes(defaultServiceTier) ? { defaultServiceTier } : {}),
    ...(api === 'anthropic-messages' && webSearch === true ? { webSearch: true } : {}),
    ...(model.streaming !== undefined ? { streaming: model.streaming } : {}),
  };
}

function validateCapabilities(config: RelayConfig, input: CompleteInput): void {
  const model = effectiveModelCapabilities(config.model, config.api);
  if (input.reasoningEffort !== undefined) {
    if (typeof input.reasoningEffort !== 'string' || !input.reasoningEffort || !model?.reasoningEfforts?.includes(input.reasoningEffort)) throw new ModelServiceError('UNSUPPORTED_CAPABILITY', '当前模型不支持该 reasoning effort');
  }
  if (input.serviceTier !== undefined) {
    if (typeof input.serviceTier !== 'string' || !input.serviceTier || !model?.serviceTiers?.includes(input.serviceTier)) throw new ModelServiceError('UNSUPPORTED_CAPABILITY', '当前模型不支持该 service tier');
  }
}

function addOpenAiOptions(body: Record<string, unknown>, config: RelayConfig, input: CompleteInput): void {
  const model = effectiveModelCapabilities(config.model, config.api);
  const reasoningEffort = input.reasoningEffort ?? model?.defaultReasoningEffort;
  const serviceTier = input.serviceTier ?? model?.defaultServiceTier;
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  if (serviceTier) body.service_tier = serviceTier;
}

export function normalizeResponse(api: string, payload: unknown, model: string): { content: string | ContentBlock[] | null; toolCalls?: NeutralToolCall[]; usage?: NormalizedUsage } {
  if (api === 'openai-completions') return normalizeOpenAi(payload, model);
  if (api === 'anthropic-messages') return normalizeAnthropic(payload, model);
  throw new ModelServiceError('MODEL_SERVICE_UNSUPPORTED_API', '模型服务配置使用了不支持的 API 协议');
}

function openAiMessages(messages: NeutralMessage[], system?: string): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  if (system) result.push({ role: 'system', content: system });
  for (const message of messages) {
    if (message.role === 'tool' && hasImageContent(message.content)) {
      const text = openAiTextContent(message.content);
      result.push({ role: 'tool', content: text, ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}) });
      result.push({ role: 'user', content: [{ type: 'text', text }, ...openAiImageParts(message.content)] });
      continue;
    }
    const value: Record<string, unknown> = { role: message.role, content: openAiContent(message.content) };
    if (message.role === 'assistant' && message.toolCalls?.length) value.tool_calls = message.toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }));
    if (message.role === 'tool' && message.toolCallId) value.tool_call_id = message.toolCallId;
    result.push(value);
  }
  return result;
}

function anthropicMessages(messages: NeutralMessage[]): Array<{ role: 'user' | 'assistant'; content: unknown }> {
  return messages.map((message) => {
    if (message.role === 'tool') {
      const content = [{ type: 'tool_result', ...(message.toolCallId ? { tool_use_id: message.toolCallId } : {}), ...(message.isError ? { is_error: true } : {}), content: anthropicContent(message.content) }];
      return { role: 'user', content };
    }
    const content = message.role === 'assistant' && message.toolCalls?.length
      ? [...asAnthropicBlocks(message.content), ...message.toolCalls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: parseArguments(call.arguments) }))]
      : anthropicContent(message.content);
    return { role: message.role, content };
  });
}

function openAiContent(content: NeutralMessage['content']): unknown {
  if (typeof content === 'string' || content === null) return content;
  return content.map((block) => {
    if (block.type === 'text') return { type: 'text', text: block.text };
    if (block.type === 'image') return { type: 'image_url', image_url: { url: `data:${block.mediaType};base64,${block.data}` } };
    return block;
  });
}

function hasImageContent(content: NeutralMessage['content']): boolean { return Array.isArray(content) && content.some((block) => block.type === 'image'); }
function openAiTextContent(content: NeutralMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((block) => block.type === 'text').map((block) => (block as { text: string }).text).join('');
}
function openAiImageParts(content: NeutralMessage['content']): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block.type === 'image').map((block) => { const image = block as { mediaType: string; data: string }; return { type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.data}` } }; });
}

function anthropicContent(content: NeutralMessage['content']): unknown {
  if (typeof content === 'string' || content === null) return content;
  return content.map((block) => {
    if (block.type === 'text') return { type: 'text', text: block.text };
    if (block.type === 'image') return { type: 'image', source: { type: 'base64', media_type: block.mediaType, data: block.data } };
    return block;
  });
}

function asAnthropicBlocks(content: NeutralMessage['content']): Array<Record<string, unknown>> {
  const normalized = anthropicContent(content);
  if (typeof normalized === 'string') return normalized ? [{ type: 'text', text: normalized }] : [];
  return Array.isArray(normalized) ? normalized as Array<Record<string, unknown>> : [];
}
function openAiTool(tool: ModelTool): Record<string, unknown> { return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }; }
function anthropicTool(tool: ModelTool): Record<string, unknown> { return { name: tool.name, description: tool.description, input_schema: tool.inputSchema }; }
function parseArguments(value: string): Record<string, unknown> { try { const parsed = JSON.parse(value) as unknown; return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } }

function normalizeOpenAi(payload: unknown, model: string): { content: string | ContentBlock[] | null; toolCalls?: NeutralToolCall[]; usage?: NormalizedUsage } {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { choices?: unknown }).choices)) throw new ModelServiceError('MODEL_SERVICE_INVALID_RESPONSE', `模型 ${model} 返回了无效响应`);
  const response = payload as { choices: Array<{ message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }>; usage?: unknown };
  const message = response.choices[0]?.message;
  if (!message || typeof message !== 'object') throw new ModelServiceError('MODEL_SERVICE_INVALID_RESPONSE', `模型 ${model} 返回了无效消息`);
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const call = value as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    if (typeof call.id !== 'string' || typeof call.function?.name !== 'string') return [];
    return [{ id: call.id, name: call.function.name, arguments: typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments ?? {}) }];
  }) : [];
  const content = normalizeOpenAiContent(message.content);
  if (content === null && calls.length === 0) throw new ModelServiceError('MODEL_SERVICE_INVALID_RESPONSE', `模型 ${model} 返回了空消息`);
  return { content, ...(calls.length ? { toolCalls: calls } : {}), ...(normalizeUsage('openai', response.usage) ? { usage: normalizeUsage('openai', response.usage) } : {}) };
}

function normalizeAnthropic(payload: unknown, model: string): { content: string | ContentBlock[] | null; toolCalls?: NeutralToolCall[]; usage?: NormalizedUsage } {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { content?: unknown }).content)) throw new ModelServiceError('MODEL_SERVICE_INVALID_RESPONSE', `模型 ${model} 返回了无效响应`);
  const response = payload as { content: unknown[]; usage?: unknown };
  const blocks = response.content.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const block = value as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') return [{ type: 'text', text: block.text } as ContentBlock];
    if (block.type === 'image' && block.source && typeof block.source === 'object') {
      const source = block.source as Record<string, unknown>;
      if (source.type === 'base64' && typeof source.media_type === 'string' && typeof source.data === 'string') return [{ type: 'image', mediaType: source.media_type, data: source.data } as ContentBlock];
    }
    return [];
  });
  const calls = response.content.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const block = value as Record<string, unknown>;
    if (block.type !== 'tool_use' || typeof block.id !== 'string' || typeof block.name !== 'string') return [];
    return [{ id: block.id, name: block.name, arguments: JSON.stringify(block.input && typeof block.input === 'object' ? block.input : {}) }];
  });
  if (blocks.length === 0 && calls.length === 0) throw new ModelServiceError('MODEL_SERVICE_INVALID_RESPONSE', `模型 ${model} 返回了空内容`);
  const textOnly = blocks.length > 0 && blocks.every((block) => block.type === 'text');
  return { content: textOnly ? blocks.map((block) => (block as { text: string }).text).join('') : blocks, ...(calls.length ? { toolCalls: calls } : {}), ...(normalizeUsage('anthropic', response.usage) ? { usage: normalizeUsage('anthropic', response.usage) } : {}) };
}

function normalizeOpenAiContent(content: unknown): string | ContentBlock[] | null {
  if (content === null || typeof content === 'string') return content as string | null;
  if (!Array.isArray(content)) return null;
  const blocks = content.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const block = value as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') return [{ type: 'text', text: block.text } as ContentBlock];
    if (block.type === 'image_url' && block.image_url && typeof block.image_url === 'object') {
      const url = (block.image_url as { url?: unknown }).url;
      if (typeof url === 'string' && url.startsWith('data:')) { const match = /^data:([^;]+);base64,(.*)$/su.exec(url); if (match) return [{ type: 'image', mediaType: match[1], data: match[2] } as ContentBlock]; }
    }
    return [];
  });
  return blocks;
}

export function normalizeUsage(api: 'openai' | 'anthropic', value: unknown): NormalizedUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const usage = value as Record<string, unknown>;
  const number = (input: unknown): number | undefined => typeof input === 'number' && Number.isFinite(input) && input >= 0 ? Math.floor(input) : undefined;
  const input = api === 'openai' ? number(usage.prompt_tokens) : number(usage.input_tokens);
  const output = api === 'openai' ? number(usage.completion_tokens) : number(usage.output_tokens);
  const cacheRead = api === 'openai' ? number((usage.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens) : number(usage.cache_read_input_tokens);
  const cacheWrite = api === 'anthropic' ? number(usage.cache_creation_input_tokens) : undefined;
  const reasoning = api === 'openai' ? number((usage.completion_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens) : undefined;
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined && reasoning === undefined) return undefined;
  const inputTokens = Math.max(0, (input || 0) - (cacheRead || 0));
  const outputTokens = output || 0;
  return { inputTokens, outputTokens, totalTokens: number(usage.total_tokens) ?? inputTokens + outputTokens + (cacheRead || 0) + (cacheWrite || 0), ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }), ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }), ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }) };
}
