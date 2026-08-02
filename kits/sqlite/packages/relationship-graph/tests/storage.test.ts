import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDatabaseLayoutIdentity,
  createRelationshipLayoutStore,
  type PersistedRelationshipStateV1,
} from '../src/index.js';

class MemoryStorage implements Pick<Storage, 'getItem' | 'setItem'> {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const fixedDigest = async (): Promise<string> => 'same-digest';

function stateAt(x: number, y: number): PersistedRelationshipStateV1 {
  return {
    nodes: { users: { x, y } },
    viewport: { x: x / 2, y: y / 2, scale: 0.8 },
    canvas: { width: 900, height: 600 },
  };
}

describe('relationship layout storage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps exact identities separate inside a digest collision bucket', async () => {
    const storage = new MemoryStorage();
    const left = createDatabaseLayoutIdentity('sqlite', ['/tmp/a.db', 'dev:1:ino:2']);
    const right = createDatabaseLayoutIdentity('sqlite', ['/tmp/b.db', 'dev:1:ino:3']);
    const store = createRelationshipLayoutStore(storage, {
      digest: fixedDigest,
      now: () => 20,
    });

    await store.save(left, stateAt(10, 20));
    await store.save(right, stateAt(30, 40));

    expect(await store.load(left)).toEqual(stateAt(10, 20));
    expect(await store.load(right)).toEqual(stateAt(30, 40));
    const bucket = JSON.parse(storage.values.values().next().value as string);
    expect(bucket.entries.map((entry: { identity: string }) => entry.identity)).toEqual([
      left.canonical,
      right.canonical,
    ]);
  });

  it('uses separate cache keys for SQLite and MySQL even with the same digest', async () => {
    const storage = new MemoryStorage();
    const store = createRelationshipLayoutStore(storage, { digest: fixedDigest });

    await store.save(createDatabaseLayoutIdentity('sqlite', ['/tmp/a.db']), stateAt(1, 2));
    await store.save(createDatabaseLayoutIdentity('mysql', ['db:3306', 'app']), stateAt(3, 4));

    expect([...storage.values.keys()].sort()).toEqual([
      'itharbors:relationship-layout:v1:mysql:same-digest',
      'itharbors:relationship-layout:v1:sqlite:same-digest',
    ]);
  });

  it('returns clones instead of mutable cached state references', async () => {
    const storage = new MemoryStorage();
    const identity = createDatabaseLayoutIdentity('sqlite', ['/tmp/a.db']);
    const store = createRelationshipLayoutStore(storage, { digest: fixedDigest });
    await store.save(identity, stateAt(10, 20));

    const loaded = await store.load(identity);
    loaded!.nodes.users.x = 999;

    expect((await store.load(identity))!.nodes.users.x).toBe(10);
  });

  it('ignores corrupt, wrong-version, and invalid state records', async () => {
    const storage = new MemoryStorage();
    const identity = createDatabaseLayoutIdentity('sqlite', ['/tmp/a.db']);
    const key = 'itharbors:relationship-layout:v1:sqlite:same-digest';
    const store = createRelationshipLayoutStore(storage, { digest: fixedDigest });

    storage.values.set(key, '{bad json');
    expect(await store.load(identity)).toBeNull();

    storage.values.set(key, JSON.stringify({ version: 2, entries: [] }));
    expect(await store.load(identity)).toBeNull();

    storage.values.set(key, JSON.stringify({
      version: 1,
      entries: [{
        identity: identity.canonical,
        updatedAt: 1,
        state: {
          nodes: { users: { x: 1, y: 2 } },
          viewport: { x: 0, y: 0, scale: Number.POSITIVE_INFINITY },
          canvas: { width: 900, height: 600 },
        },
      }],
    }));
    expect(await store.load(identity)).toBeNull();
  });

  it('replaces corrupt storage with a valid bucket on the next save', async () => {
    const storage = new MemoryStorage();
    const identity = createDatabaseLayoutIdentity('sqlite', ['/tmp/a.db']);
    const key = 'itharbors:relationship-layout:v1:sqlite:same-digest';
    const store = createRelationshipLayoutStore(storage, { digest: fixedDigest });
    storage.values.set(key, 'corrupt');

    await store.save(identity, stateAt(1, 2));

    expect(await store.load(identity)).toEqual(stateAt(1, 2));
    expect(JSON.parse(storage.values.get(key)!).version).toBe(1);
  });

  it('keeps the eight newest exact identities in a collision bucket', async () => {
    const storage = new MemoryStorage();
    let now = 0;
    const store = createRelationshipLayoutStore(storage, {
      digest: fixedDigest,
      now: () => now,
    });
    const identities = Array.from({ length: 10 }, (_, index) => (
      createDatabaseLayoutIdentity('sqlite', [`/tmp/${index}.db`])
    ));

    for (const [index, identity] of identities.entries()) {
      now = index;
      await store.save(identity, stateAt(index, index));
    }

    const bucket = JSON.parse(storage.values.values().next().value as string);
    expect(bucket.entries).toHaveLength(8);
    expect(bucket.entries.map((entry: { identity: string }) => entry.identity)).toEqual(
      identities.slice(2).map((identity) => identity.canonical),
    );
  });

  it('re-reads a bucket before saving and retains another writer entry', async () => {
    const storage = new MemoryStorage();
    const left = createDatabaseLayoutIdentity('sqlite', ['/tmp/a.db']);
    const right = createDatabaseLayoutIdentity('sqlite', ['/tmp/b.db']);
    const key = 'itharbors:relationship-layout:v1:sqlite:same-digest';
    const store = createRelationshipLayoutStore(storage, { digest: fixedDigest, now: () => 10 });
    await store.save(left, stateAt(1, 2));
    const bucket = JSON.parse(storage.values.get(key)!);
    bucket.entries.push({ identity: right.canonical, updatedAt: 5, state: stateAt(3, 4) });
    storage.values.set(key, JSON.stringify(bucket));

    await store.save(left, stateAt(5, 6));

    expect(await store.load(left)).toEqual(stateAt(5, 6));
    expect(await store.load(right)).toEqual(stateAt(3, 4));
  });

  it('silently falls back when storage or an injected digest fails', async () => {
    const identity = createDatabaseLayoutIdentity('sqlite', ['/tmp/a.db']);
    const throwingStorage = {
      getItem(): string | null { throw new Error('read denied'); },
      setItem(): void { throw new Error('quota'); },
    };
    const throwingDigest = async (): Promise<string> => { throw new Error('digest failed'); };

    const storageStore = createRelationshipLayoutStore(throwingStorage, { digest: fixedDigest });
    await expect(storageStore.load(identity)).resolves.toBeNull();
    await expect(storageStore.save(identity, stateAt(1, 2))).resolves.toBeUndefined();

    const digestStore = createRelationshipLayoutStore(new MemoryStorage(), {
      digest: throwingDigest,
    });
    await expect(digestStore.load(identity)).resolves.toBeNull();
    await expect(digestStore.save(identity, stateAt(1, 2))).resolves.toBeUndefined();
  });

  it('uses a stable non-cryptographic key when Web Crypto is unavailable', async () => {
    vi.stubGlobal('crypto', {});
    const storage = new MemoryStorage();
    const identity = createDatabaseLayoutIdentity('sqlite', ['/tmp/a.db']);
    const store = createRelationshipLayoutStore(storage);

    await store.save(identity, stateAt(1, 2));
    const firstKey = [...storage.values.keys()][0];
    await store.save(identity, stateAt(3, 4));

    expect(firstKey).toMatch(/^itharbors:relationship-layout:v1:sqlite:[0-9a-f]{8}$/);
    expect([...storage.values.keys()]).toEqual([firstKey]);
    expect(await store.load(identity)).toEqual(stateAt(3, 4));
  });
});
