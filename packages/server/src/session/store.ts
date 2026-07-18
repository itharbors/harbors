import Database from 'better-sqlite3';

export interface SessionRow {
  sessionId: string;
  workspacePath: string;
  savedFileList: string;
  createdAt: number;
  lastAccessAt: number;
}

export class SessionStore {
  private db: Database.Database;
  private stmtGet: Database.Statement;
  private stmtUpsert: Database.Statement;
  private stmtDelete: Database.Statement;

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
    this.stmtGet = this.db.prepare('SELECT * FROM sessions WHERE sessionId = ?');
    this.stmtUpsert = this.db.prepare(`
      INSERT INTO sessions (sessionId, workspacePath, savedFileList, createdAt, lastAccessAt)
      VALUES (@sessionId, @workspacePath, @savedFileList, @createdAt, @lastAccessAt)
      ON CONFLICT(sessionId) DO UPDATE SET
        workspacePath = excluded.workspacePath,
        savedFileList = excluded.savedFileList,
        lastAccessAt = excluded.lastAccessAt
    `);
    this.stmtDelete = this.db.prepare('DELETE FROM sessions WHERE sessionId = ?');
  }

  get(sessionId: string): SessionRow | undefined {
    return this.stmtGet.get(sessionId) as SessionRow | undefined;
  }

  upsert(row: SessionRow): void {
    this.stmtUpsert.run(row);
  }

  delete(sessionId: string): void {
    this.stmtDelete.run(sessionId);
  }

  close(): void {
    this.db.close();
  }
}