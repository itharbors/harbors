import { describe, expect, it } from 'vitest';
import {
  acceptResponse,
  beginRequest,
  createWorkbenchState,
  moveRowSelection,
  pushSqlHistory,
  selectObject,
  selectionIntent,
} from '../panel.workbench/src/state';

describe('SQLite panel state', () => {
  it('moves a single row selection and exposes keyboard intent', () => {
    expect(moveRowSelection(null, 'down', 3)).toBe(0);
    expect(moveRowSelection(0, 'up', 3)).toBe(0);
    expect(moveRowSelection(1, 'down', 3)).toBe(2);
    expect(selectionIntent(' ')).toBe('select');
    expect(selectionIntent('Enter')).toBe('edit');
  });

  it('resets object-specific data without losing the SQL draft or history', () => {
    const state = createWorkbenchState();
    state.sqlText = 'SELECT 1';
    state.sqlHistory = ['SELECT 2'];
    state.page = 3;
    state.search = 'old';
    state.selectedRowIndex = 4;

    const next = selectObject(state, 'users');
    expect(next).toMatchObject({
      selectedName: 'users',
      page: 1,
      search: '',
      filters: [],
      sorts: [],
      selectedRowIndex: null,
      sqlText: 'SELECT 1',
      sqlHistory: ['SELECT 2'],
    });
  });

  it('deduplicates SQL history and caps it at twenty entries', () => {
    let history: string[] = [];
    for (let index = 0; index < 22; index += 1) history = pushSqlHistory(history, `SELECT ${index}`);
    history = pushSqlHistory(history, 'SELECT 21');
    expect(history).toHaveLength(20);
    expect(history[0]).toBe('SELECT 21');
    expect(new Set(history).size).toBe(20);
  });

  it('rejects stale async responses by request sequence', () => {
    const state = createWorkbenchState();
    const first = beginRequest(state, 'rows');
    const second = beginRequest(first.state, 'rows');
    expect(acceptResponse(second.state, 'rows', first.sequence)).toBe(false);
    expect(acceptResponse(second.state, 'rows', second.sequence)).toBe(true);
  });
});
