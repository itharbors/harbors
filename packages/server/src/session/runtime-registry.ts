import type { Editor } from '../editor/types';
import type { Session, SessionManager } from './manager';

export interface SessionRuntimeCreateOptions {
  workspacePath?: string;
  kit?: string;
  kitName?: string;
  kitPath?: string;
  locale?: string;
  /** Stable Kit identity used only to address one runtime inside a client session. */
  runtimeKit?: string;
}

export interface SessionRuntime {
  session: Session;
  editor: Editor;
}

export type SessionRuntimeFactory = (
  session: Session,
  options: SessionRuntimeCreateOptions,
) => Promise<Editor> | Editor;

export const SESSION_RUNTIME_REGISTRY_CLOSED = 'SESSION_RUNTIME_REGISTRY_CLOSED';

export class SessionRuntimeRegistryClosedError extends Error {
  readonly code = SESSION_RUNTIME_REGISTRY_CLOSED;

  constructor() {
    super('Session runtime registry is closed');
    this.name = 'SessionRuntimeRegistryClosedError';
  }
}

export class SessionRuntimeRegistry {
  private readonly runtimes = new Map<string, Editor>();
  private readonly pending = new Map<string, Promise<SessionRuntime>>();
  private readonly runtimeOwners = new Map<string, string>();
  private accepting = true;
  private disposePromise: Promise<void> | undefined;

  constructor(
    private readonly manager: SessionManager,
    private readonly createRuntime: SessionRuntimeFactory,
  ) {}

  get editors(): ReadonlyMap<string, Editor> {
    return this.runtimes;
  }

  get(sessionId: string): Editor | undefined {
    return this.runtimes.get(sessionId);
  }

  resolveBaseSessionId(runtimeId: string): string | undefined {
    return this.runtimeOwners.get(runtimeId);
  }

  getOrCreate(
    sessionId: string,
    options: SessionRuntimeCreateOptions,
  ): Promise<SessionRuntime> {
    if (!this.accepting) return Promise.reject(new SessionRuntimeRegistryClosedError());

    const runtimeId = getRuntimeId(sessionId, options.runtimeKit);
    const existingEditor = this.runtimes.get(runtimeId);
    if (existingEditor) {
      const session = this.manager.get(sessionId);
      if (!session) {
        return Promise.reject(new Error(`Session "${sessionId}" runtime has no persistent session`));
      }
      return Promise.resolve({ session, editor: existingEditor });
    }

    const existingPending = this.pending.get(runtimeId);
    if (existingPending) return existingPending;

    const existedBefore = this.manager.get(sessionId) !== undefined;
    const pending = (async () => {
      const session = this.manager.getOrCreate(sessionId, options.workspacePath ?? '');
      try {
        const editor = await this.createRuntime(session, options);
        this.runtimes.set(runtimeId, editor);
        this.runtimeOwners.set(runtimeId, session.sessionId);
        return { session, editor };
      } catch (error) {
        if (!existedBefore) {
          this.manager.destroy(sessionId);
        }
        throw error;
      } finally {
        this.pending.delete(runtimeId);
      }
    })();

    this.pending.set(runtimeId, pending);
    return pending;
  }

  async destroy(sessionId: string): Promise<boolean> {
    const runtimePrefix = `${sessionId}::`;
    const runtimeIds = new Set<string>([
      ...[...this.runtimes.keys()].filter((runtimeId) => (
        runtimeId === sessionId || runtimeId.startsWith(runtimePrefix)
      )),
      ...[...this.pending.keys()].filter((runtimeId) => (
        runtimeId === sessionId || runtimeId.startsWith(runtimePrefix)
      )),
    ]);
    const existed = this.manager.get(sessionId) !== undefined || runtimeIds.size > 0;
    if (!existed) return false;

    const pendingRuntimes = [...runtimeIds]
      .map((runtimeId) => this.pending.get(runtimeId))
      .filter((pending): pending is Promise<SessionRuntime> => pending !== undefined);
    for (const pending of pendingRuntimes) {
      try {
        await pending;
      } catch {
        // A failed runtime is already removed by its factory transaction;
        // continue so other runtimes belonging to the client session are
        // still disposed.
      }
    }

    const editors = [...runtimeIds]
      .map((runtimeId) => [runtimeId, this.runtimes.get(runtimeId)] as const)
      .filter((entry): entry is readonly [string, Editor] => entry[1] !== undefined);
    for (const [runtimeId] of editors) this.runtimes.delete(runtimeId);
    for (const runtimeId of runtimeIds) this.runtimeOwners.delete(runtimeId);
    try {
      for (const [, editor] of editors) await editor.dispose();
    } finally {
      this.manager.destroy(sessionId);
    }
    return true;
  }

  disposeAll(): Promise<void> {
    if (!this.disposePromise) {
      this.accepting = false;
      this.disposePromise = this.disposeAllInternal();
    }
    return this.disposePromise;
  }

  private async disposeAllInternal(): Promise<void> {
    await Promise.allSettled(this.pending.values());
    const editors = Array.from(this.runtimes.values());
    this.runtimes.clear();
    this.runtimeOwners.clear();
    const results = await Promise.allSettled(editors.map((editor) => editor.dispose()));
    const errors = results.flatMap((result) => (
      result.status === 'rejected' ? [result.reason] : []
    ));
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Session runtime disposal failed');
    }
  }
}

export function getRuntimeId(sessionId: string, kit?: string): string {
  return kit ? `${sessionId}::${kit}` : sessionId;
}
