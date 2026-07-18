import type { Editor } from '../editor/types';
import type { Session, SessionManager } from './manager';

export interface SessionRuntimeCreateOptions {
  workspacePath?: string;
  kit?: string;
  kitName?: string;
  kitPath?: string;
  locale?: string;
}

export interface SessionRuntime {
  session: Session;
  editor: Editor;
}

export type SessionRuntimeFactory = (
  session: Session,
  options: SessionRuntimeCreateOptions,
) => Promise<Editor> | Editor;

export class SessionRuntimeRegistry {
  private readonly runtimes = new Map<string, Editor>();
  private readonly pending = new Map<string, Promise<SessionRuntime>>();

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

  getOrCreate(
    sessionId: string,
    options: SessionRuntimeCreateOptions,
  ): Promise<SessionRuntime> {
    const existingEditor = this.runtimes.get(sessionId);
    if (existingEditor) {
      const session = this.manager.get(sessionId);
      if (!session) {
        return Promise.reject(new Error(`Session "${sessionId}" runtime has no persistent session`));
      }
      return Promise.resolve({ session, editor: existingEditor });
    }

    const existingPending = this.pending.get(sessionId);
    if (existingPending) return existingPending;

    const existedBefore = this.manager.get(sessionId) !== undefined;
    const pending = (async () => {
      const session = this.manager.getOrCreate(sessionId, options.workspacePath ?? '');
      try {
        const editor = await this.createRuntime(session, options);
        this.runtimes.set(sessionId, editor);
        return { session, editor };
      } catch (error) {
        if (!existedBefore) {
          this.manager.destroy(sessionId);
        }
        throw error;
      } finally {
        this.pending.delete(sessionId);
      }
    })();

    this.pending.set(sessionId, pending);
    return pending;
  }

  async destroy(sessionId: string): Promise<boolean> {
    const existed = this.manager.get(sessionId) !== undefined
      || this.runtimes.has(sessionId)
      || this.pending.has(sessionId);
    if (!existed) return false;

    const pending = this.pending.get(sessionId);
    if (pending) {
      try {
        await pending;
      } catch {
        this.manager.destroy(sessionId);
        return true;
      }
    }

    const editor = this.runtimes.get(sessionId);
    this.runtimes.delete(sessionId);
    try {
      await editor?.dispose();
    } finally {
      this.manager.destroy(sessionId);
    }
    return true;
  }

  async disposeAll(): Promise<void> {
    await Promise.allSettled(this.pending.values());
    const editors = Array.from(this.runtimes.values());
    this.runtimes.clear();
    const results = await Promise.allSettled(editors.map((editor) => editor.dispose()));
    const errors = results.flatMap((result) => (
      result.status === 'rejected' ? [result.reason] : []
    ));
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Session runtime disposal failed');
    }
  }
}
