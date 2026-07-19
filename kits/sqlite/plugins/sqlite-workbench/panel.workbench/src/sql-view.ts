import { pushSqlHistory } from './state.js';

export function lineNumberText(sql: string): string {
  return sql.split('\n').map((_, index) => String(index + 1)).join('\n');
}

export function historyAfterExecution(history: string[], sql: string): string[] {
  return pushSqlHistory(history, sql);
}

export function paginateSqlRows<T>(rows: T[], page: number): { rows: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(rows.length / 50));
  const normalized = Math.max(1, Math.min(totalPages, page));
  return { rows: rows.slice((normalized - 1) * 50, normalized * 50), totalPages };
}
