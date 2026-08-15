import Database from 'better-sqlite3';

export interface AuthorizedDeviceRow {
  deviceId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
}

export interface AuthorizedDevice {
  deviceId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class DeviceStore {
  private db: Database.Database;
  private stmtGet: Database.Statement;
  private stmtUpsert: Database.Statement;
  private stmtDelete: Database.Statement;
  private stmtList: Database.Statement;
  private stmtTouch: Database.Statement;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS authorized_devices (
        deviceId TEXT PRIMARY KEY,
        createdAt INTEGER NOT NULL DEFAULT 0,
        expiresAt INTEGER NOT NULL DEFAULT 0,
        lastSeenAt INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.stmtGet = this.db.prepare('SELECT * FROM authorized_devices WHERE deviceId = ?');
    this.stmtUpsert = this.db.prepare(`
      INSERT INTO authorized_devices (deviceId, createdAt, expiresAt, lastSeenAt)
      VALUES (@deviceId, @createdAt, @expiresAt, @lastSeenAt)
      ON CONFLICT(deviceId) DO UPDATE SET
        expiresAt = excluded.expiresAt,
        lastSeenAt = excluded.lastSeenAt
    `);
    this.stmtDelete = this.db.prepare('DELETE FROM authorized_devices WHERE deviceId = ?');
    this.stmtList = this.db.prepare('SELECT * FROM authorized_devices ORDER BY lastSeenAt DESC');
    this.stmtTouch = this.db.prepare(
      'UPDATE authorized_devices SET lastSeenAt = ? WHERE deviceId = ?',
    );
  }

  get(deviceId: string): AuthorizedDevice | undefined {
    const row = this.stmtGet.get(deviceId) as AuthorizedDeviceRow | undefined;
    return row ? rowToDevice(row) : undefined;
  }

  isAuthorized(deviceId: string): boolean {
    const device = this.get(deviceId);
    if (!device) return false;
    return device.expiresAt > Date.now();
  }

  authorize(deviceId: string, ttlMs: number = DEFAULT_TTL_MS): AuthorizedDevice {
    const now = Date.now();
    const existing = this.get(deviceId);
    const row: AuthorizedDeviceRow = {
      deviceId,
      createdAt: existing?.createdAt ?? now,
      expiresAt: now + ttlMs,
      lastSeenAt: now,
    };
    this.stmtUpsert.run(row);
    return rowToDevice(row);
  }

  revoke(deviceId: string): void {
    this.stmtDelete.run(deviceId);
  }

  list(): AuthorizedDevice[] {
    const rows = this.stmtList.all() as AuthorizedDeviceRow[];
    return rows.map(rowToDevice);
  }

  touch(deviceId: string): void {
    this.stmtTouch.run(Date.now(), deviceId);
  }

  close(): void {
    this.db.close();
  }
}

function rowToDevice(row: AuthorizedDeviceRow): AuthorizedDevice {
  return {
    deviceId: row.deviceId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastSeenAt: row.lastSeenAt,
  };
}

export { DEFAULT_TTL_MS };
