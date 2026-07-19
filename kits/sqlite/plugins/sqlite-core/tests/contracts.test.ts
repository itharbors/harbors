import { describe, expect, it } from 'vitest';
import {
  CORE_TOPICS,
  SQLITE_CORE,
  SQLITE_EXPLORER,
  SELECTION_CHANGED_TOPIC,
  SqliteRequestError,
  unwrapSqliteResponse,
} from '@itharbors/sqlite-contracts';

describe('SQLite shared plugin contracts', () => {
  it('uses stable plugin names and broadcast topics', () => {
    expect(SQLITE_CORE).toBe('@itharbors/sqlite-core');
    expect(SQLITE_EXPLORER).toBe('@itharbors/sqlite-explorer');
    expect(CORE_TOPICS).toEqual({
      connectionChanged: '@itharbors/sqlite.connection.changed',
      schemaChanged: '@itharbors/sqlite.schema.changed',
      dataChanged: '@itharbors/sqlite.data.changed',
    });
    expect(SELECTION_CHANGED_TOPIC).toBe('@itharbors/sqlite.selection.changed');
  });

  it('unwraps successful responses and raises structured request errors', () => {
    expect(unwrapSqliteResponse<{ ok: true }>({ ok: true })).toEqual({ ok: true });

    let error: unknown;
    try {
      unwrapSqliteResponse({
        $sqliteError: { code: 'READ_ONLY', message: '当前连接为只读模式。', detail: 'raw detail' },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(SqliteRequestError);
    expect(error).toMatchObject({
      code: 'READ_ONLY',
      message: '当前连接为只读模式。',
      detail: 'raw detail',
    });
  });
});
