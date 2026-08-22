export type ModelServiceErrorCode =
  | 'UNAUTHORIZED'
  | 'INVALID_INPUT'
  | 'UNSUPPORTED_CAPABILITY'
  | 'MODEL_SERVICE_NOT_CONFIGURED'
  | 'MODEL_SERVICE_UNSUPPORTED_API'
  | 'MODEL_SERVICE_HTTP_ERROR'
  | 'MODEL_SERVICE_CONTEXT_OVERFLOW'
  | 'MODEL_SERVICE_INVALID_RESPONSE'
  | 'MODEL_SERVICE_NETWORK_ERROR'
  | 'MODEL_SERVICE_TIMEOUT'
  | 'MODEL_SERVICE_CANCELLED'
  | 'MODEL_SERVICE_STOPPED';

export interface ErrorEnvelope {
  code: ModelServiceErrorCode;
  message: string;
  retryable: boolean;
  requestId: string;
}

const RETRYABLE_CODES = new Set<ModelServiceErrorCode>(['MODEL_SERVICE_NETWORK_ERROR', 'MODEL_SERVICE_TIMEOUT', 'MODEL_SERVICE_HTTP_ERROR']);

export class ModelServiceError extends Error {
  readonly name = 'ModelServiceError';
  readonly retryable: boolean;
  readonly requestId: string;

  constructor(readonly code: ModelServiceErrorCode, message: string, options: { cause?: unknown; retryable?: boolean; requestId?: string } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.retryable = options.retryable ?? RETRYABLE_CODES.has(code);
    this.requestId = options.requestId || '';
  }

  envelope(requestId = this.requestId): ErrorEnvelope {
    return { code: this.code, message: this.message, retryable: this.retryable, requestId };
  }

  toJSON(): ErrorEnvelope {
    return this.envelope();
  }
}

export interface ModelCatalogEntry {
  id: string;
  name: string;
  description?: string;
  contextWindow?: number;
  reasoningEfforts?: string[];
  serviceTiers?: string[];
  defaultReasoningEffort?: string;
  defaultServiceTier?: string;
  webSearch?: boolean;
  /** Provider 是否声明可用真实流式响应；未声明时按适配器默认支持。 */
  streaming?: boolean;
}

export interface ModelCatalog {
  models: ModelCatalogEntry[];
  defaultModel: string;
  configurationError?: {
    code: 'MISSING_BASE_URL' | 'MISSING_CREDENTIAL';
    message: string;
  };
}

export type ModelCatalogChangedReason = 'provider-saved' | 'provider-deleted' | 'credential-reset';

export interface ModelCatalogChangedPayload {
  revision: number;
  reason: ModelCatalogChangedReason;
  catalog: ModelCatalog;
}

export interface TextContentBlock { type: 'text'; text: string; }
export interface ImageContentBlock { type: 'image'; mediaType: string; data: string; }
export type ContentBlock = TextContentBlock | ImageContentBlock | Record<string, unknown>;

export interface NeutralToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface NeutralMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[] | null;
  toolCalls?: NeutralToolCall[];
  toolCallId?: string;
  isError?: boolean;
}

export interface ModelTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CompleteInput {
  requestId: string;
  purpose: 'turn' | 'compaction';
  model?: string;
  system?: string;
  messages: NeutralMessage[];
  tools?: ModelTool[];
  maxOutputTokens?: number;
  retryMode?: 'default' | 'disabled';
  reasoningEffort?: string;
  serviceTier?: string;
  /** milliseconds; a caller can only shorten the configured provider timeout */
  timeoutMs?: number;
  /** 请求真实 Provider streaming；不支持时由 Model Service 使用非流式兼容路径。 */
  stream?: boolean;
  /** 调用方为一次重启/替换生成的 opaque generation。 */
  generation?: string;
}

export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface CompleteOutput {
  requestId: string;
  model: string;
  message: {
    role: 'assistant';
    content: string | ContentBlock[] | null;
    toolCalls?: NeutralToolCall[];
  };
  usage?: NormalizedUsage;
}

export type ModelDelta =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; callId: string; name?: string; arguments?: string };

export interface CompleteDelta {
  requestId: string;
  generation: string;
  /** 单一 request/generation 内从 0 开始严格递增。 */
  sequence: number;
  delta: ModelDelta;
}

export interface WebSearchInput { requestId: string; query: string; timeoutMs?: number; }
export interface WebSearchOutput { requestId: string; result: string; }
export interface CancelInput { requestId: string; }
export type CancelState = 'cancelled' | 'already_cancelled' | 'completed' | 'timed_out' | 'failed' | 'not_found';
export interface CancelOutput { requestId: string; state: CancelState; }
