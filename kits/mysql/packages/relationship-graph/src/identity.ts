export type DatabaseLayoutIdentity = {
  engine: 'sqlite' | 'mysql';
  canonical: string;
};

export function createDatabaseLayoutIdentity(
  engine: DatabaseLayoutIdentity['engine'],
  parts: readonly string[],
): DatabaseLayoutIdentity {
  return {
    engine,
    canonical: `${engine}${parts.map((part) => `|${part.length}:${part}`).join('')}`,
  };
}
