const compareOptions: Intl.CollatorOptions = {
  sensitivity: 'base',
  numeric: true,
};

export function compareTableNames(left: string, right: string): number {
  return left.localeCompare(right, 'en', compareOptions)
    || left.localeCompare(right, 'en', { numeric: true });
}

export function tokenizeTableName(name: string): string[] {
  const separated = name.normalize('NFKC')
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .replace(/(\p{L})(\p{N})/gu, '$1 $2')
    .replace(/(\p{N})(\p{L})/gu, '$1 $2');
  return (separated.match(/[\p{L}]+|[\p{N}]+/gu) ?? [])
    .map((token) => normalizeToken(token.toLocaleLowerCase('en')));
}

export function normalizedTableName(name: string): string {
  const tokens = tokenizeTableName(name);
  return tokens.length === 0 ? name.normalize('NFKC').toLocaleLowerCase('en') : tokens.join('_');
}

function normalizeToken(token: string): string {
  if (/^[a-z]+$/.test(token)) {
    if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
    if (token.length > 3 && token.endsWith('s') && !/(ss|us|is)$/.test(token)) {
      return token.slice(0, -1);
    }
  }
  return token;
}
