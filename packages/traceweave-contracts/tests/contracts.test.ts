import { describe, expect, it } from 'vitest';

import {
  TRACEWEAVE_PLUGIN,
  isTraceweaveError,
} from '../src/index';

describe('TraceWeave public contract', () => {
  it('uses one stable core-plugin identity across Panel requests', () => {
    expect(TRACEWEAVE_PLUGIN).toBe('@itharbors/traceweave-core');
  });

  it('recognizes only complete public error envelopes', () => {
    expect(isTraceweaveError({
      $traceweaveError: { code: 'RUN_NOT_FOUND', message: 'Run not found' },
    })).toBe(true);
    expect(isTraceweaveError({ $traceweaveError: { code: '', message: 'x' } })).toBe(false);
    expect(isTraceweaveError({ code: 'RUN_NOT_FOUND', message: 'Run not found' })).toBe(false);
    expect(isTraceweaveError(null)).toBe(false);
  });
});
