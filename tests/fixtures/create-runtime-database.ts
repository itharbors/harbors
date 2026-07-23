import Database from 'better-sqlite3';

export function createRuntimeDatabase(databasePath: string): void {
  const database = new Database(databasePath);
  try {
    database.exec(`
      CREATE TABLE teams (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE
      );
      CREATE TABLE members (
        id INTEGER PRIMARY KEY,
        team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        note TEXT
      );
      CREATE VIEW active_members AS
        SELECT id, name FROM members WHERE note IS NOT NULL;
      CREATE INDEX members_name_idx ON members(name);
      INSERT INTO teams (name) VALUES ('Platform');
      INSERT INTO members (team_id, name, note) VALUES
        (1, 'Alice', 'owner'),
        (1, 'Bob', NULL);
    `);
  } finally {
    database.close();
  }
}
