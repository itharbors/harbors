export type ModelServiceErrorCode =
  | 'MODEL_SERVICE_NOT_CONFIGURED'
  | 'MODEL_SERVICE_UNSUPPORTED_API'
  | 'MODEL_SERVICE_HTTP_ERROR'
  | 'MODEL_SERVICE_CONTEXT_OVERFLOW'
  | 'MODEL_SERVICE_INVALID_RESPONSE'
  | 'MODEL_SERVICE_NETWORK_ERROR'
  | 'MODEL_SERVICE_TIMEOUT'
  | 'MODEL_SERVICE_CANCELLED'
  | 'MODEL_SERVICE_STOPPED';

export class ModelServiceError extends Error {
  readonly name = 'ModelServiceError';

  constructor(readonly code: ModelServiceErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
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

export interface CancelOutput { requestId: string; state: 'cancelled' | 'completed' | 'not_found'; }
