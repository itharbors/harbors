import { describe, expect, it } from 'vitest';

import { parseNettopRow } from '../main/src/nettop-parser.js';

describe('nettop parser', () => {
  it('parses bounded cumulative counters without converting bigint to number', () => {
    expect(parseNettopRow('41,1000,sha256:claude,tcp,203.0.113.10:443,ESTABLISHED,2048,4096,1754000000000'))
      .toEqual({
        observedAt: 1_754_000_000_000,
        pid: 41,
        processStartTime: 1000,
        executableIdentity: 'sha256:claude',
        remoteAddress: '203.0.113.10:443',
        transport: 'tcp',
        state: 'ESTABLISHED',
        bytesIn: 2048n,
        bytesOut: 4096n,
      });
  });

  it('rejects malformed, negative, and oversized rows', () => {
    expect(() => parseNettopRow('bad,row')).toThrow(/columns/iu);
    expect(() => parseNettopRow('41,1000,id,tcp,remote,state,-1,2,3')).toThrow(/bytesIn/iu);
    expect(() => parseNettopRow('x'.repeat(70_000))).toThrow(/length/iu);
  });
});
