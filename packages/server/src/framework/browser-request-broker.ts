import { randomUUID } from 'node:crypto';
import type { BrowserDispatchResult } from '@itharbors/plugin-types';

export interface BrowserRequestTarget {
  panel: string;
  method: string;
  args: unknown[];
}

export interface BrowserRequestEvent extends BrowserRequestTarget {
  type: 'panel-dispatch';
  requestId: string;
}

export type BrowserRequestResolution = 'resolved' | 'wrong-session' | 'missing';

interface PendingBrowserRequest {
  sessionId: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class BrowserRequestBroker {
  private readonly pending = new Map<string, PendingBrowserRequest>();
  private destroyed = false;

  request(
    sessionId: string,
    dispatch: (event: BrowserRequestEvent) => void,
    target: BrowserRequestTarget,
    timeoutMs = 10_000,
  ): Promise<unknown> {
    if (this.destroyed) {
      return Promise.reject(new Error('BrowserRequestBroker destroyed'));
    }

    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Browser request ${requestId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(requestId, { sessionId, resolve, reject, timer });

      try {
        dispatch({ type: 'panel-dispatch', requestId, ...target });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(toError(error));
      }
    });
  }

  resolve(
    sessionId: string,
    requestId: string,
    result: BrowserDispatchResult,
  ): BrowserRequestResolution {
    const pending = this.pending.get(requestId);
    if (!pending) return 'missing';
    if (pending.sessionId !== sessionId) return 'wrong-session';

    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    if (result.ok) {
      pending.resolve(result.value);
    } else {
      pending.reject(new Error(result.error));
    }
    return 'resolved';
  }

  rejectSession(sessionId: string, reason: Error): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.reject(reason);
    }
  }

  pendingCount(): number {
    return this.pending.size;
  }

  destroy(): void {
    if (this.destroyed && this.pending.size === 0) return;
    this.destroyed = true;
    const reason = new Error('BrowserRequestBroker destroyed');
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.reject(reason);
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
