import Database from 'better-sqlite3';

export interface SessionRow {
  sessionId: string;
  workspacePath: string;
  savedFileList: string;
  createdAt: number;
  lastAccessAt: number;
  ownerUserId?: string | null;
}

export class SessionStore {
  private db: Database.Database;
  private stmtGet: Database.Statement;
  private stmtUpsert: Database.Statement;
  private stmtDelete: Database.Statement;
  private stmtList: Database.Statement;
  private stmtClaim: Database.Statement;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sessionId TEXT PRIMARY KEY,
        workspacePath TEXT NOT NULL DEFAULT '',
        savedFileList TEXT NOT NULL DEFAULT '[]',
        createdAt INTEGER NOT NULL DEFAULT 0,
        lastAccessAt INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.db.transaction(() => {
      const columns = this.db.pragma('table_info(sessions)') as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'ownerUserId')) {
        this.db.exec('ALTER TABLE sessions ADD COLUMN ownerUserId TEXT');
      }
    })();
    this.stmtGet = this.db.prepare('SELECT * FROM sessions WHERE sessionId = ?');
    this.stmtUpsert = this.db.prepare(`
      INSERT INTO sessions (sessionId, workspacePath, savedFileList, createdAt, lastAccessAt, ownerUserId)
      VALUES (@sessionId, @workspacePath, @savedFileList, @createdAt, @lastAccessAt, @ownerUserId)
      ON CONFLICT(sessionId) DO UPDATE SET
        workspacePath = excluded.workspacePath,
        savedFileList = excluded.savedFileList,
        lastAccessAt = excluded.lastAccessAt,
        ownerUserId = COALESCE(sessions.ownerUserId, excluded.ownerUserId)
    `);
    this.stmtDelete = this.db.prepare('DELETE FROM sessions WHERE sessionId = ?');
    this.stmtList = this.db.prepare('SELECT * FROM sessions ORDER BY lastAccessAt DESC');
    this.stmtClaim = this.db.prepare(
      'UPDATE sessions SET ownerUserId = ? WHERE sessionId = ? AND ownerUserId IS NULL',
    );
  }

  get(sessionId: string): SessionRow | undefined {
    return this.stmtGet.get(sessionId) as SessionRow | undefined;
  }

  upsert(row: SessionRow): void {
    this.stmtUpsert.run({ ...row, ownerUserId: row.ownerUserId ?? null });
  }

  delete(sessionId: string): void {
    this.stmtDelete.run(sessionId);
  }

  list(ownerUserId?: string | null): SessionRow[] {
    if (ownerUserId === undefined) return this.stmtList.all() as SessionRow[];
    if (ownerUserId === null) {
      return this.db.prepare('SELECT * FROM sessions WHERE ownerUserId IS NULL ORDER BY lastAccessAt DESC').all() as SessionRow[];
    }
    return this.db.prepare('SELECT * FROM sessions WHERE ownerUserId = ? ORDER BY lastAccessAt DESC').all(ownerUserId) as SessionRow[];
  }

  claim(sessionId: string, ownerUserId: string): boolean {
    return this.stmtClaim.run(ownerUserId, sessionId).changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
