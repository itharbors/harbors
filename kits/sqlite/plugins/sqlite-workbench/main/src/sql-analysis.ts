import { WorkbenchError } from './protocol.js';

export type SqlTextAnalysis = {
  readonly: boolean;
  statementType: string;
  targetObjects: string[];
  risk: 'normal' | 'high';
};

type Token = { value: string; upper: string; depth: number };

const READONLY_STATEMENTS = new Set(['SELECT', 'EXPLAIN']);
const WRITE_STATEMENTS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CREATE', 'ALTER', 'DROP', 'VACUUM', 'ATTACH', 'DETACH',
]);
const QUERY_PRAGMAS_WITH_ARGUMENT = new Set([
  'FOREIGN_KEY_CHECK',
  'FOREIGN_KEY_LIST',
  'INDEX_INFO',
  'INDEX_LIST',
  'INDEX_XINFO',
  'INTEGRITY_CHECK',
  'QUICK_CHECK',
  'TABLE_INFO',
  'TABLE_LIST',
  'TABLE_XINFO',
]);
const QUERY_PRAGMAS_BARE = new Set([
  ...QUERY_PRAGMAS_WITH_ARGUMENT,
  'APPLICATION_ID',
  'COLLATION_LIST',
  'COMPILE_OPTIONS',
  'DATABASE_LIST',
  'DATA_VERSION',
  'ENCODING',
  'FOREIGN_KEYS',
  'FREELIST_COUNT',
  'FUNCTION_LIST',
  'JOURNAL_MODE',
  'MODULE_LIST',
  'PAGE_COUNT',
  'PRAGMA_LIST',
  'SCHEMA_VERSION',
  'USER_VERSION',
]);

export function analyzeSqlText(sql: string): SqlTextAnalysis {
  if (typeof sql !== 'string' || sql.trim() === '') {
    throw new WorkbenchError('INVALID_SQL', '请输入要执行的 SQL。');
  }
  const statements = splitStatements(sql);
  if (statements.length !== 1) {
    throw new WorkbenchError('MULTIPLE_STATEMENTS', '一次只能执行一条 SQL 语句。');
  }
  const tokens = tokenize(statements[0]);
  if (tokens.length === 0) throw new WorkbenchError('INVALID_SQL', '请输入要执行的 SQL。');

  const first = tokens[0].upper;
  const statementType = first === 'WITH'
    ? findWithStatementType(tokens)
    : first === 'EXPLAIN' && tokens[1]?.upper === 'QUERY' ? 'EXPLAIN' : first;
  const readonly = READONLY_STATEMENTS.has(statementType)
    || (statementType === 'PRAGMA' && isReadonlyPragma(tokens));
  if (!readonly && !WRITE_STATEMENTS.has(statementType) && statementType !== 'PRAGMA') {
    throw new WorkbenchError('UNSUPPORTED_SQL', `暂不支持分析 ${statementType} 语句。`);
  }
  const targetObjects = findTargets(tokens, statementType);
  const hasTopLevelWhere = tokens.some((token) => token.depth === 0 && token.upper === 'WHERE');
  const risk = ['CREATE', 'ALTER', 'DROP', 'VACUUM', 'ATTACH', 'DETACH'].includes(statementType)
    || ((statementType === 'UPDATE' || statementType === 'DELETE') && !hasTopLevelWhere)
    ? 'high'
    : 'normal';
  return { readonly, statementType, targetObjects, risk };
}

function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | '`' | ']' | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; index += 1; }
      continue;
    }
    if (quote !== null) {
      if (quote === ']' ? char === ']' : char === quote) {
        if (quote !== ']' && next === quote) { index += 1; continue; }
        quote = null;
      }
      continue;
    }
    if (char === '-' && next === '-') { lineComment = true; index += 1; continue; }
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      quote = char === '[' ? ']' : char;
      continue;
    }
    if (char === ';') {
      if (isInsideCreateTriggerBody(sql.slice(start, index))) continue;
      const statement = sql.slice(start, index).trim();
      if (stripComments(statement).trim() !== '') statements.push(statement);
      start = index + 1;
    }
  }
  const tail = sql.slice(start).trim();
  if (stripComments(tail).trim() !== '') statements.push(tail);
  return statements;
}

function isInsideCreateTriggerBody(sql: string): boolean {
  const tokens = tokenize(sql);
  const triggerIndex = tokens.findIndex((token) => token.depth === 0 && token.upper === 'TRIGGER');
  if (tokens[0]?.upper !== 'CREATE' || triggerIndex < 0) return false;
  const beginIndex = tokens.findIndex((token, index) => (
    index > triggerIndex && token.depth === 0 && token.upper === 'BEGIN'
  ));
  if (beginIndex < 0) return false;
  let caseDepth = 0;
  for (const token of tokens.slice(beginIndex + 1)) {
    if (token.depth !== 0) continue;
    if (token.upper === 'CASE') caseDepth += 1;
    if (token.upper !== 'END') continue;
    if (caseDepth > 0) caseDepth -= 1;
    else return false;
  }
  return true;
}

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\//g, ' ');
}

function tokenize(sql: string): Token[] {
  const source = stripComments(sql);
  const tokens: Token[] = [];
  let depth = 0;
  const pattern = /"(?:""|[^"])*"|`(?:``|[^`])*`|\[(?:\]\]|[^\]])*\]|'(?:''|[^'])*'|[A-Za-z_][\w$]*|[().,=]/g;
  for (const match of source.matchAll(pattern)) {
    const value = match[0];
    if (value === '(') { tokens.push({ value, upper: value, depth }); depth += 1; continue; }
    if (value === ')') { depth = Math.max(0, depth - 1); tokens.push({ value, upper: value, depth }); continue; }
    tokens.push({ value: unquote(value), upper: unquote(value).toUpperCase(), depth });
  }
  return tokens.filter((token) => !token.value.startsWith("'"));
}

function isReadonlyPragma(tokens: Token[]): boolean {
  if (tokens.some((token) => token.value === '=')) return false;
  const openingIndex = tokens.findIndex((token) => token.value === '(');
  if (openingIndex < 0) {
    const pragmaName = tokens.at(-1)?.upper;
    return pragmaName !== undefined && QUERY_PRAGMAS_BARE.has(pragmaName);
  }
  const pragmaName = tokens[openingIndex - 1]?.upper;
  return pragmaName !== undefined && QUERY_PRAGMAS_WITH_ARGUMENT.has(pragmaName);
}

function unquote(value: string): string {
  if (value.startsWith('"')) return value.slice(1, -1).replaceAll('""', '"');
  if (value.startsWith('`')) return value.slice(1, -1).replaceAll('``', '`');
  if (value.startsWith('[')) return value.slice(1, -1).replaceAll(']]', ']');
  return value;
}

function findWithStatementType(tokens: Token[]): string {
  const token = tokens.find((candidate, index) => (
    index > 0
    && candidate.depth === 0
    && ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE'].includes(candidate.upper)
  ));
  if (!token) throw new WorkbenchError('INVALID_SQL', '无法识别 WITH 语句的主体。');
  return token.upper;
}

function findTargets(tokens: Token[], statementType: string): string[] {
  if (statementType === 'SELECT') return targetAfter(tokens, 'FROM');
  if (statementType === 'INSERT' || statementType === 'REPLACE') {
    return requiredMutationTarget(tokens, statementType, targetAfter(tokens, 'INTO'));
  }
  if (statementType === 'UPDATE') {
    return requiredMutationTarget(tokens, statementType, targetAfter(tokens, 'UPDATE'));
  }
  if (statementType === 'DELETE') {
    return requiredMutationTarget(tokens, statementType, targetAfter(tokens, 'FROM'));
  }
  if (statementType === 'ALTER') {
    return requiredMutationTarget(tokens, statementType, targetAfter(tokens, 'TABLE'));
  }
  if (statementType === 'CREATE' || statementType === 'DROP') {
    const typeIndex = tokens.findIndex((token) => (
      token.depth === 0 && ['TABLE', 'VIEW', 'INDEX', 'TRIGGER'].includes(token.upper)
    ));
    if (typeIndex < 0) return [];
    const objectType = tokens[typeIndex].upper;
    const targets = statementType === 'CREATE' && (objectType === 'INDEX' || objectType === 'TRIGGER')
      ? targetAfter(tokens, 'ON', typeIndex + 1)
      : nextIdentifier(tokens, typeIndex + 1);
    return requiredMutationTarget(tokens, statementType, targets);
  }
  return [];
}

function nextIdentifier(tokens: Token[], start: number): string[] {
  const ignored = new Set([
    'IF', 'NOT', 'EXISTS', 'OR', 'REPLACE', 'ABORT', 'FAIL', 'IGNORE', 'ROLLBACK',
  ]);
  const index = tokens.findIndex((candidate, candidateIndex) => (
    candidateIndex >= start
    && candidate.depth === 0
    && !ignored.has(candidate.upper)
    && !['(', ')', ',', '=', '.'].includes(candidate.value)
  ));
  if (index < 0) return [];
  const dot = tokens[index + 1];
  const qualified = tokens[index + 2];
  return dot?.depth === 0 && dot.value === '.' && qualified?.depth === 0
    ? [qualified.value]
    : [tokens[index].value];
}

function targetAfter(tokens: Token[], marker: string, start = 0): string[] {
  const index = tokens.findIndex((token, tokenIndex) => (
    tokenIndex >= start && token.depth === 0 && token.upper === marker
  ));
  return index < 0 ? [] : nextIdentifier(tokens, index + 1);
}

function requiredMutationTarget(tokens: Token[], statementType: string, targets: string[]): string[] {
  if (targets.length > 0) return targets;
  const statement = tokens.map((token) => token.value).join(' ');
  throw new WorkbenchError(
    'UNSUPPORTED_SQL_TARGET',
    `无法安全识别 ${statementType} 语句的目标对象。`,
    statement,
  );
}
