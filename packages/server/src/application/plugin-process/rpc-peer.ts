import {
  PLUGIN_PROCESS_PROTOCOL,
  type PluginProcessEnvelope,
  type PluginProcessErrorPayload,
  type PluginProcessResponse,
  parsePluginProcessEnvelope,
} from './protocol';

const DEFAULT_MAX_PENDING = 256;

export type PluginProcessRpcResponse = Pick<Extract<PluginProcessResponse, { ok: true }>, 'ok' | 'payload'>
  | Pick<Extract<PluginProcessResponse, { ok: false }>, 'ok' | 'error'>;

export interface PluginProcessRpcPeer {
  request(method: string, payload: unknown): Promise<unknown>;
  respond(requestId: string, response: PluginProcessRpcResponse): void;
  emit(event: string, payload: unknown): void;
  close(error: Error): void;
}

export interface CreatePluginProcessRpcPeerOptions {
  generation: string;
  send(envelope: PluginProcessEnvelope): void;
  subscribe(listener: (input: unknown) => void): () => void;
  maxPending?: number;
}

export function createPluginProcessRpcPeer(options: CreatePluginProcessRpcPeerOptions): PluginProcessRpcPeer {
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
  if (!Number.isInteger(maxPending) || maxPending < 1 || maxPending > DEFAULT_MAX_PENDING) {
    throw new RangeError('maxPending must be an integer from 1 to 256');
  }

  let nextRequestId = 1;
  let terminalError: Error | undefined;
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  const unsubscribe = options.subscribe((input) => {
    let envelope: PluginProcessEnvelope;
    try {
      envelope = parsePluginProcessEnvelope(input, options.generation);
    } catch {
      return;
    }
    if (envelope.kind !== 'response') {
      return;
    }
    const request = pending.get(envelope.requestId);
    if (!request) {
      return;
    }
    pending.delete(envelope.requestId);
    if (envelope.ok) {
      request.resolve(envelope.payload);
      return;
    }
    request.reject(normalizeRemoteError(envelope.error));
  });

  return {
    request(method, payload) {
      if (terminalError) {
        return Promise.reject(terminalError);
      }
      if (pending.size >= maxPending) {
        return Promise.reject(new Error(`Plugin process has reached ${maxPending} pending requests`));
      }

      const requestId = String(nextRequestId);
      nextRequestId += 1;
      try {
        const envelope = parsePluginProcessEnvelope({
          protocol: PLUGIN_PROCESS_PROTOCOL,
          generation: options.generation,
          kind: 'request',
          requestId,
          method,
          payload,
        }, options.generation);
        return new Promise<unknown>((resolve, reject) => {
          pending.set(requestId, { resolve, reject });
          try {
            options.send(envelope);
          } catch (error) {
            pending.delete(requestId);
            reject(toError(error));
          }
        });
      } catch (error) {
        return Promise.reject(toError(error));
      }
    },
    respond(requestId, response) {
      const envelope = response.ok
        ? {
          protocol: PLUGIN_PROCESS_PROTOCOL,
          generation: options.generation,
          kind: 'response' as const,
          requestId,
          ok: true as const,
          payload: response.payload,
        }
        : {
          protocol: PLUGIN_PROCESS_PROTOCOL,
          generation: options.generation,
          kind: 'response' as const,
          requestId,
          ok: false as const,
          error: response.error,
        };
      options.send(parsePluginProcessEnvelope(envelope, options.generation));
    },
    emit(event, payload) {
      options.send(parsePluginProcessEnvelope({
        protocol: PLUGIN_PROCESS_PROTOCOL,
        generation: options.generation,
        kind: 'event',
        event,
        payload,
      }, options.generation));
    },
    close(error) {
      if (terminalError) {
        return;
      }
      terminalError = error;
      unsubscribe();
      for (const request of pending.values()) {
        request.reject(error);
      }
      pending.clear();
    },
  };
}

function normalizeRemoteError(payload: PluginProcessErrorPayload): Error & PluginProcessErrorPayload {
  const error = Object.assign(new Error(payload.message), {
    code: payload.code,
    ...(payload.retryable === undefined ? {} : { retryable: payload.retryable }),
    ...(payload.retryAfterMs === undefined ? {} : { retryAfterMs: payload.retryAfterMs }),
  });
  return error;
}

function toError(input: unknown): Error {
  return input instanceof Error ? input : new Error(String(input));
}
