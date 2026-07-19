import { formatSql, sqlLineNumbers, tokenizeSql } from './sql-format.js';

type ObjectKind = 'table' | 'view' | 'virtual' | 'shadow';

export function groupSchemaObjects<T extends { kind: ObjectKind }>(objects: T[]): Array<{
  kind: ObjectKind;
  objects: T[];
  collapsed: boolean;
}> {
  return (['table', 'view', 'virtual', 'shadow'] as const).flatMap((kind) => {
    const matching = objects.filter((object) => object.kind === kind);
    return matching.length === 0 ? [] : [{ kind, objects: matching, collapsed: kind === 'shadow' }];
  });
}

export function renderSqlCode(sql: string): HTMLElement {
  const formatted = formatSql(sql);
  const container = document.createElement('div');
  container.className = 'sql-code';
  const gutter = document.createElement('span');
  gutter.className = 'sql-line-numbers';
  for (const number of sqlLineNumbers(formatted)) {
    const line = document.createElement('span');
    line.className = 'sql-line-number';
    line.textContent = String(number);
    gutter.append(line);
  }
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  for (const token of tokenizeSql(formatted)) {
    const span = document.createElement('span');
    span.className = `sql-token-${token.kind}`;
    span.textContent = token.text;
    code.append(span);
  }
  pre.append(code);
  container.append(gutter, pre);
  return container;
}
