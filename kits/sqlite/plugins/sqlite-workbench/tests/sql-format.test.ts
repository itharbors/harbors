import { describe, expect, it } from 'vitest';
import {
  completionCandidates,
  formatSql,
  sqlLineNumbers,
  tokenizeSql,
} from '../panel.workbench/src/sql-format';

describe('SQLite SQL presentation helpers', () => {
  it('formats common DDL using whitespace only and produces real line numbers', () => {
    const source = 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);';
    const formatted = formatSql(source);
    expect(formatted.replace(/\s/g, '')).toBe(source.replace(/\s/g, ''));
    expect(formatted).toContain('\n');
    expect(sqlLineNumbers(formatted)).toEqual(
      Array.from({ length: formatted.split('\n').length }, (_, index) => index + 1),
    );
  });

  it('does not treat keywords inside strings or comments as keyword tokens', () => {
    const tokens = tokenizeSql("SELECT 'FROM users' AS note -- WHERE hidden\nFROM users");
    expect(tokens.filter((token) => token.kind === 'keyword').map((token) => token.text)).toEqual([
      'SELECT', 'AS', 'FROM',
    ]);
    expect(tokens.map((token) => token.text).join('')).toContain("'FROM users'");
  });

  it('falls back to original text for malformed quoted SQL', () => {
    expect(formatSql("SELECT 'unfinished")).toBe("SELECT 'unfinished");
    expect(tokenizeSql("SELECT 'unfinished")).toEqual([
      { kind: 'text', text: "SELECT 'unfinished" },
    ]);
  });

  it('combines SQLite keywords and current object names for completion', () => {
    expect(completionCandidates('us', ['users', 'user_events', 'teams'])).toEqual([
      'user_events', 'users',
    ]);
    expect(completionCandidates('sel', [])).toContain('SELECT');
  });
});
