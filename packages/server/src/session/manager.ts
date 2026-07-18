import type { SessionStore, SessionRow } from './store';

export interface Session {
  sessionId: string;
  workspacePath: string;
  savedFileList: string[];
  createdAt: number;
  lastAccessAt: number;
}

export class SessionManager {
  constructor(private store: SessionStore) {}

  getOrCreate(sessionId: string, workspacePath = ''): Session {
    const existing = this.store.get(sessionId);
    if (existing) {
      const now = Date.now();
      this.store.upsert({ ...existing, lastAccessAt: now });
      return rowToSession({ ...existing, lastAccessAt: now });
    }

    const now = Date.now();
    const row: SessionRow = {
      sessionId,
      workspacePath,
      savedFileList: '[]',
      createdAt: now,
      lastAccessAt: now,
    };
    this.store.upsert(row);
    return rowToSession(row);
  }

  get(sessionId: string): Session | undefined {
    const row = this.store.get(sessionId);
    if (!row) return undefined;
    return rowToSession(row);
  }

  destroy(sessionId: string): void {
    this.store.delete(sessionId);
  }
}

function rowToSession(row: SessionRow): Session {
  return {
    sessionId: row.sessionId,
    workspacePath: row.workspacePath,
    savedFileList: JSON.parse(row.savedFileList),
    createdAt: row.createdAt,
    lastAccessAt: row.lastAccessAt,
  };
}