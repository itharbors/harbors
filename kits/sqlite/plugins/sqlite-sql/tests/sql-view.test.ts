import { describe, expect, it } from 'vitest';
import { historyAfterExecution, lineNumberText, paginateSqlRows } from '../panel.sql/src/sql-view';

describe('SQLite SQL view helpers', () => {
  it('renders one real line number per SQL line', () => {
    expect(lineNumberText('SELECT 1\nFROM users\nWHERE id = 1')).toBe('1\n2\n3');
  });

  it('deduplicates and caps successful SQL history', () => {
    let history: string[] = [];
    for (let index = 0; index < 21; index += 1) history = historyAfterExecution(history, `SELECT ${index}`);
    history = historyAfterExecution(history, 'SELECT 20');
    expect(history).toHaveLength(20);
    expect(history[0]).toBe('SELECT 20');
  });

  it('pages SQL rows at fifty without rendering the complete result', () => {
    const rows = Array.from({ length: 120 }, (_, index) => [index]);
    expect(paginateSqlRows(rows, 2)).toEqual({ rows: rows.slice(50, 100), totalPages: 3 });
  });
});
