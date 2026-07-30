import { describe, expect, it } from 'vitest';

import { RollingBaseline } from '../main/src/baseline.js';

describe('rolling baseline', () => {
  it('returns bounded median and MAD without retaining more than seven days', () => {
    const baseline = new RollingBaseline(3);
    baseline.add(1);
    baseline.add(1000);
    baseline.add(3);
    baseline.add(5);

    expect(baseline.snapshot()).toEqual({ median: 5, mad: 2, samples: 3 });
    expect(baseline.values()).toEqual([1000, 3, 5]);
  });
});
