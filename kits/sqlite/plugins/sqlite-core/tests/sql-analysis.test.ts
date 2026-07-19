import { describe, expect, it } from 'vitest';
import { analyzeSqlText } from '../main/src/sql-analysis';

describe('SQLite SQL analysis', () => {
  it('recognizes readonly SELECT, WITH, and query PRAGMA statements', () => {
    expect(analyzeSqlText('-- comment\nSELECT * FROM users')).toMatchObject({
      readonly: true,
      statementType: 'SELECT',
      targetObjects: ['users'],
      risk: 'normal',
    });
    expect(analyzeSqlText('WITH chosen AS (SELECT id FROM users) SELECT * FROM chosen')).toMatchObject({
      readonly: true,
      statementType: 'SELECT',
    });
    expect(analyzeSqlText('PRAGMA table_info(users)')).toMatchObject({
      readonly: true,
      statementType: 'PRAGMA',
    });
    expect(analyzeSqlText('PRAGMA main.index_info(users_email)')).toMatchObject({
      readonly: true,
      statementType: 'PRAGMA',
    });
  });

  it('requires write confirmation for persistent parenthesized PRAGMAs', () => {
    for (const sql of [
      'PRAGMA user_version(123)',
      'PRAGMA main.application_id(456)',
      'PRAGMA journal_mode(WAL)',
      'PRAGMA optimize',
      'PRAGMA wal_checkpoint',
      'PRAGMA incremental_vacuum',
    ]) {
      expect(analyzeSqlText(sql)).toMatchObject({
        readonly: false,
        statementType: 'PRAGMA',
      });
    }
    expect(analyzeSqlText('PRAGMA user_version')).toMatchObject({ readonly: true });
    expect(analyzeSqlText('PRAGMA database_list')).toMatchObject({ readonly: true });
  });

  it('classifies writes and raises risk for DDL or missing WHERE clauses', () => {
    expect(analyzeSqlText("UPDATE users SET name = 'A' WHERE id = 1")).toMatchObject({
      readonly: false,
      statementType: 'UPDATE',
      targetObjects: ['users'],
      risk: 'normal',
    });
    expect(analyzeSqlText("DELETE FROM users")).toMatchObject({
      readonly: false,
      statementType: 'DELETE',
      targetObjects: ['users'],
      risk: 'high',
    });
    expect(analyzeSqlText('CREATE TABLE audit (id INTEGER)')).toMatchObject({
      readonly: false,
      statementType: 'CREATE',
      targetObjects: ['audit'],
      risk: 'high',
    });
  });

  it('extracts the mutated object for every supported object-write syntax', () => {
    for (const [sql, targetObjects] of [
      ['INSERT OR REPLACE INTO main.users(id) VALUES (1)', ['users']],
      ['REPLACE INTO "main"."users"(id) VALUES (1)', ['users']],
      ['UPDATE OR ABORT [main].[users] SET name = \'A\'', ['users']],
      ['WITH chosen AS (SELECT 1) DELETE FROM `main`.`users` WHERE id = 1', ['users']],
      ['ALTER TABLE main.users RENAME TO members', ['users']],
      ['DROP VIEW IF EXISTS main.active_users', ['active_users']],
      ['CREATE INDEX users_name ON main.users(name)', ['users']],
      ['CREATE TRIGGER users_audit AFTER UPDATE ON main.users BEGIN SELECT 1; END', ['users']],
    ] as const) {
      expect(analyzeSqlText(sql).targetObjects, sql).toEqual(targetObjects);
    }
  });

  it('rejects empty and multiple statements', () => {
    expect(() => analyzeSqlText('')).toThrow(/INVALID_SQL/);
    expect(() => analyzeSqlText('SELECT 1; SELECT 2')).toThrow(/MULTIPLE_STATEMENTS/);
  });
});
