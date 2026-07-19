export type SqlToken = {
  kind: 'keyword' | 'identifier' | 'string' | 'number' | 'comment' | 'text';
  text: string;
};

const KEYWORDS = new Set([
  'ALTER', 'AS', 'BEGIN', 'BY', 'CREATE', 'DELETE', 'DROP', 'END', 'EXPLAIN', 'FROM',
  'GROUP', 'HAVING', 'INDEX', 'INSERT', 'INTO', 'JOIN', 'LIMIT', 'NOT', 'NULL', 'ON',
  'ORDER', 'PRAGMA', 'PRIMARY', 'SELECT', 'SET', 'TABLE', 'TRIGGER', 'UNION', 'UPDATE',
  'VALUES', 'VIEW', 'WHERE', 'WITH',
]);

const LINE_BREAK_KEYWORDS = new Set([
  'FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'VALUES', 'SET',
]);

export function formatSql(sql: string): string {
  if (!isBalanced(sql)) return sql;
  const tokens = tokenizeSql(sql);
  const pieces = tokens.map((token) => (
    token.kind === 'text' ? formatWhitespaceBetweenTokens(token.text) : token.text
  ));

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== 'keyword' || !LINE_BREAK_KEYWORDS.has(token.text.toUpperCase())) continue;
    if (tokens[index - 1].kind !== 'text') continue;
    pieces[index - 1] = pieces[index - 1].replace(/[ \t\r\n]+$/, '\n');
  }

  if (tokens[0]?.kind === 'text') pieces[0] = pieces[0].replace(/^[ \t\r\n]+/, '');
  const lastIndex = tokens.length - 1;
  if (tokens[lastIndex]?.kind === 'text') {
    pieces[lastIndex] = pieces[lastIndex].replace(/[ \t\r\n]+$/, '');
  }
  return pieces.join('');
}

function formatWhitespaceBetweenTokens(text: string): string {
  return text
    .replace(/[ \t\r\n]+/g, ' ')
    .replace(/, */g, ',\n  ');
}

export function tokenizeSql(sql: string): SqlToken[] {
  if (!isBalanced(sql)) return [{ kind: 'text', text: sql }];
  const tokens: SqlToken[] = [];
  let index = 0;
  while (index < sql.length) {
    const rest = sql.slice(index);
    const comment = rest.match(/^(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)/);
    if (comment) { tokens.push({ kind: 'comment', text: comment[0] }); index += comment[0].length; continue; }
    const quoted = readQuoted(rest);
    if (quoted) { tokens.push({ kind: quoted.kind, text: quoted.text }); index += quoted.text.length; continue; }
    const word = rest.match(/^[A-Za-z_][\w$]*/);
    if (word) {
      tokens.push({ kind: KEYWORDS.has(word[0].toUpperCase()) ? 'keyword' : 'identifier', text: word[0] });
      index += word[0].length;
      continue;
    }
    const number = rest.match(/^\d+(?:\.\d+)?/);
    if (number) { tokens.push({ kind: 'number', text: number[0] }); index += number[0].length; continue; }
    const previous = tokens.at(-1);
    if (previous?.kind === 'text') previous.text += rest[0];
    else tokens.push({ kind: 'text', text: rest[0] });
    index += 1;
  }
  return tokens;
}

export function sqlLineNumbers(sql: string): number[] {
  return Array.from({ length: sql.split('\n').length }, (_, index) => index + 1);
}

export function completionCandidates(prefix: string, objects: string[]): string[] {
  const needle = prefix.trim().toLowerCase();
  if (needle === '') return [];
  return [...new Set([...KEYWORDS, ...objects])]
    .filter((candidate) => candidate.toLowerCase().startsWith(needle))
    .sort((left, right) => left.localeCompare(right, 'en', { sensitivity: 'base' }));
}

function isBalanced(sql: string): boolean {
  let quote: "'" | '"' | '`' | ']' | null = null;
  let blockComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];
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
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (char === '-' && next === '-') {
      const newline = sql.indexOf('\n', index + 2);
      index = newline === -1 ? sql.length : newline;
      continue;
    }
    if (char === "'" || char === '"' || char === '`' || char === '[') quote = char === '[' ? ']' : char;
  }
  return quote === null && !blockComment;
}

function readQuoted(source: string): { kind: 'string' | 'identifier'; text: string } | null {
  const first = source[0];
  if (!["'", '"', '`', '['].includes(first)) return null;
  const close = first === '[' ? ']' : first;
  let index = 1;
  while (index < source.length) {
    if (source[index] === close) {
      if (first !== '[' && source[index + 1] === close) { index += 2; continue; }
      return { kind: first === "'" ? 'string' : 'identifier', text: source.slice(0, index + 1) };
    }
    index += 1;
  }
  return null;
}
