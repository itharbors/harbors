import Database from 'better-sqlite3';

export interface AuthorizedDeviceRow {
  deviceId: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
}

export interface AuthorizedDevice {
  deviceId: string;
  userId: string;
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
      );
      CREATE TABLE IF NOT EXISTS authorized_devices (
        deviceId TEXT PRIMARY KEY,
        createdAt INTEGER NOT NULL DEFAULT 0,
        expiresAt INTEGER NOT NULL DEFAULT 0,
        lastSeenAt INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.db.transaction(() => {
      const columns = this.db.pragma('table_info(authorized_devices)') as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'userId')) {
        this.db.exec('ALTER TABLE authorized_devices ADD COLUMN userId TEXT');
      }
      this.migrateLegacyDevices();
    })();
    this.stmtGet = this.db.prepare('SELECT * FROM authorized_devices WHERE deviceId = ?');
    this.stmtUpsert = this.db.prepare(`
      INSERT INTO authorized_devices (deviceId, userId, createdAt, expiresAt, lastSeenAt)
      VALUES (@deviceId, @userId, @createdAt, @expiresAt, @lastSeenAt)
      ON CONFLICT(deviceId) DO UPDATE SET
        userId = excluded.userId,
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

  authorize(deviceId: string, userId: string, ttlMs: number = DEFAULT_TTL_MS): AuthorizedDevice {
    const now = Date.now();
    const existing = this.get(deviceId);
    const row: AuthorizedDeviceRow = {
      deviceId,
      userId,
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
    if (this.ownsDatabase) this.db.close();
  }

  private migrateLegacyDevices(): void {
    const migrate = this.db.transaction(() => {
      const rows = this.db.prepare(
        'SELECT deviceId, createdAt, lastSeenAt FROM authorized_devices WHERE userId IS NULL',
      ).all() as Array<{ deviceId: string; createdAt: number; lastSeenAt: number }>;
      const insertUser = this.db.prepare(`
        INSERT OR IGNORE INTO users (userId, displayName, createdAt, updatedAt)
        VALUES (?, ?, ?, ?)
      `);
      const bind = this.db.prepare('UPDATE authorized_devices SET userId = ? WHERE deviceId = ? AND userId IS NULL');
      for (const row of rows) {
        const userId = `legacy-device-${row.deviceId}`;
        const timestamp = row.createdAt || row.lastSeenAt || Date.now();
        insertUser.run(userId, `设备 ${shortId(row.deviceId)}`, timestamp, timestamp);
        bind.run(userId, row.deviceId);
      }
    });
    migrate();
  }
}

function rowToDevice(row: AuthorizedDeviceRow): AuthorizedDevice {
  return {
    deviceId: row.deviceId,
    userId: row.userId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastSeenAt: row.lastSeenAt,
  };
}

function shortId(value: string): string {
  return value.length > 8 ? value.slice(0, 8) : value;
}

export { DEFAULT_TTL_MS };
