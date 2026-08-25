import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

export interface PublicUser {
  userId: string;
  displayName: string;
  createdAt: number;
  updatedAt: number;
}

export class UserStore {
  private readonly db: Database.Database;
  private readonly ownsDatabase: boolean;

  constructor(source: string | Database.Database) {
    this.ownsDatabase = typeof source === 'string';
    this.db = typeof source === 'string' ? new Database(source) : source;
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        userId TEXT PRIMARY KEY,
        displayName TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `);
  }

  create(displayName: string): PublicUser {
    const name = displayName.trim();
    if (!name || name.length > 80) throw new Error('User display name must contain 1 to 80 characters');
    const now = Date.now();
    const user = { userId: randomUUID(), displayName: name, createdAt: now, updatedAt: now };
    this.db.prepare(`
      INSERT INTO users (userId, displayName, createdAt, updatedAt)
      VALUES (@userId, @displayName, @createdAt, @updatedAt)
    `).run(user);
    return user;
  }

  get(userId: string): PublicUser | undefined {
    return this.db.prepare('SELECT * FROM users WHERE userId = ?').get(userId) as PublicUser | undefined;
  }

  list(): PublicUser[] {
    return this.db.prepare('SELECT * FROM users ORDER BY updatedAt DESC, createdAt DESC').all() as PublicUser[];
  }

  update(userId: string, displayName: string): PublicUser | undefined {
    const name = displayName.trim();
    if (!name || name.length > 80) return undefined;
    const updatedAt = Date.now();
    const result = this.db.prepare(
      'UPDATE users SET displayName = ?, updatedAt = ? WHERE userId = ?',
    ).run(name, updatedAt, userId);
    return result.changes > 0 ? this.get(userId) : undefined;
  }

  delete(userId: string): boolean {
    return this.db.prepare('DELETE FROM users WHERE userId = ?').run(userId).changes > 0;
  }

  close(): void {
    if (this.ownsDatabase) this.db.close();
  }
}
