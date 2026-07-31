import {
  TRACEWEAVE_PLUGIN,
  isTraceweaveError,
  type RawEvidenceResponse,
  type RunSummary,
  type TraceRun,
} from '@itharbors/traceweave-contracts';

export interface MessageBridge {
  request(plugin: string, method: string, ...args: unknown[]): Promise<unknown>;
}

export interface TraceweaveClient {
  listRuns(): Promise<RunSummary[]>;
  loadRun(runId: string): Promise<TraceRun>;
  loadRawEvidence(runId: string, eventId: string): Promise<RawEvidenceResponse>;
  refresh(): Promise<RunSummary[]>;
}

function unwrap<T>(response: unknown): T {
  if (isTraceweaveError(response)) throw new Error(response.$traceweaveError.message);
  return response as T;
}

export class MessageTraceweaveClient implements TraceweaveClient {
  constructor(private readonly message: MessageBridge) {}

  async listRuns(): Promise<RunSummary[]> {
    return unwrap(await this.message.request(TRACEWEAVE_PLUGIN, 'listRuns'));
  }

  async loadRun(runId: string): Promise<TraceRun> {
    return unwrap(await this.message.request(TRACEWEAVE_PLUGIN, 'loadRun', { runId }));
  }

  async loadRawEvidence(runId: string, eventId: string): Promise<RawEvidenceResponse> {
    return unwrap(await this.message.request(TRACEWEAVE_PLUGIN, 'loadRawEvidence', { runId, eventId }));
  }

  async refresh(): Promise<RunSummary[]> {
    return unwrap(await this.message.request(TRACEWEAVE_PLUGIN, 'refresh'));
  }
}
