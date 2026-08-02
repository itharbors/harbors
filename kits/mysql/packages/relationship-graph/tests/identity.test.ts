import { describe, expect, it } from 'vitest';
import { createDatabaseLayoutIdentity } from '../src/index.js';

describe('database layout identity', () => {
  it('uses engine-scoped length-prefixed canonical parts', () => {
    expect(createDatabaseLayoutIdentity('sqlite', ['/tmp/a.db', 'dev:1:ino:2'])).toEqual({
      engine: 'sqlite',
      canonical: 'sqlite|9:/tmp/a.db|11:dev:1:ino:2',
    });
    expect(createDatabaseLayoutIdentity('mysql', ['db.example:3306', 'app'])).toEqual({
      engine: 'mysql',
      canonical: 'mysql|15:db.example:3306|3:app',
    });
  });

  it('does not alias parts containing separators', () => {
    const split = createDatabaseLayoutIdentity('mysql', ['a|1:b', 'c']);
    const joined = createDatabaseLayoutIdentity('mysql', ['a', '1:b|1:c']);

    expect(split.canonical).not.toBe(joined.canonical);
  });
});
