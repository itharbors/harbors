import { describe, expect, it } from 'vitest';

import { BoundedMap, BoundedSet } from '../main/src/bounded-cache.js';

describe('bounded traffic identity caches', () => {
  it('evicts the oldest identity and keeps refreshed identities bounded', () => {
    const map = new BoundedMap<number, string>(2);
    map.set(1, 'one').set(2, 'two').set(1, 'updated').set(3, 'three');
    expect([...map]).toEqual([[1, 'updated'], [3, 'three']]);

    const set = new BoundedSet<number>(2);
    set.add(1).add(2).add(1).add(3);
    expect([...set]).toEqual([1, 3]);
  });

  it('stays bounded under a long stream of unique connections', () => {
    const cache = new BoundedSet<number>(256);
    for (let index = 0; index < 100_000; index += 1) cache.add(index);
    expect(cache.size).toBe(256);
    expect(cache.has(99_999)).toBe(true);
  });
});
