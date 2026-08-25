import type { IncomingMessage } from 'node:http';
import type { RequestActor } from '../auth';
import type { SessionManager } from './manager';
import type { SessionRuntimeRegistry } from './runtime-registry';
import type { Editor } from '../editor/types';
import { HttpError } from '../http/errors';

export type RequestActorResolver = (req: IncomingMessage) => RequestActor;
export type SessionAccessGuard = (req: IncomingMessage, runtimeOrSessionId: string) => void;

export class SessionAccessPolicy {
  constructor(
    private readonly manager: SessionManager,
    private readonly registry: Pick<SessionRuntimeRegistry, 'resolveBaseSessionId' | 'get' | 'editors'>,
  ) {}

  canAccessSession(actor: RequestActor, sessionId: string): boolean {
    if (actor.kind === 'local-admin') return true;
    if (actor.kind !== 'user') return false;
    return this.manager.get(sessionId)?.ownerUserId === actor.userId;
  }

  assertAccess(actor: RequestActor, runtimeOrSessionId: string): void {
    const baseSessionId = this.registry.resolveBaseSessionId(runtimeOrSessionId)
      ?? (this.manager.get(runtimeOrSessionId) ? runtimeOrSessionId : undefined);
    if (!baseSessionId) throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session not found');
    if (!this.canAccessSession(actor, baseSessionId)) {
      throw new HttpError(403, 'SESSION_FORBIDDEN', 'Session belongs to another user');
    }
  }

  getEditor(actor: RequestActor, runtimeId: string): Editor | undefined {
    this.assertAccess(actor, runtimeId);
    return this.registry.get(runtimeId);
  }

  listEditors(actor: RequestActor): ReadonlyMap<string, Editor> {
    if (actor.kind === 'local-admin') return this.registry.editors;
    const visible = new Map<string, Editor>();
    for (const [runtimeId, editor] of this.registry.editors) {
      const sessionId = this.registry.resolveBaseSessionId(runtimeId);
      if (sessionId && this.canAccessSession(actor, sessionId)) visible.set(runtimeId, editor);
    }
    return visible;
  }
}
