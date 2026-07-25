import iconv from 'iconv-lite';
import { describe, expect, it } from 'vitest';
import {
  decodeSample,
  detectDelimiter,
  detectSample,
} from '../main/src/detection.js';

describe('CSV sample detection', () => {
  it('returns a bounded preview from the first logical quoted record', () => {
    const detected = detectSample(Buffer.from('"first, field","line one\nline two",abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz,tail\n1,2,3,4\n'));

    expect(detected.preview).toEqual({
      cells: ['first, field', 'line one\nline two', 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuv'],
      truncated: true,
    });
  });
  it('recognizes a UTF-8 BOM and parses quoted physical newlines', () => {
    expect(detectSample(Buffer.from('\uFEFFname,notes\r\nA,"x\ny"\r\n'))).toMatchObject({
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: true,
    });
  });

  it('strictly accepts valid UTF-8 and falls back to GB18030 for invalid UTF-8', () => {
    expect(detectSample(Buffer.from('名称,数量\n苹果,2\n')).encoding).toBe('utf8');
    const encoded = iconv.encode('名称,数量\n苹果,2\n', 'gb18030');
    expect(detectSample(encoded)).toMatchObject({ encoding: 'gb18030', delimiter: ',' });
    expect(decodeSample(encoded, 'gb18030')).toContain('苹果');
  });

  it('rejects invalid bytes when UTF-8 is explicitly requested', () => {
    expect(() => decodeSample(Buffer.from([0xff, 0xfe]), 'utf8')).toThrowError(
      expect.objectContaining({ code: 'INVALID_ENCODING' }),
    );
  });

  it('tolerates only an incomplete trailing UTF-8 sequence in a truncated sample', () => {
    expect(decodeSample(Buffer.from([0xe4]), 'utf8', true)).toBe('');
    expect(() => decodeSample(Buffer.from([0xe4]), 'utf8')).toThrowError(
      expect.objectContaining({ code: 'INVALID_ENCODING' }),
    );
    expect(() => decodeSample(Buffer.from([0xff, 0xe4]), 'utf8', true)).toThrowError(
      expect.objectContaining({ code: 'INVALID_ENCODING' }),
    );
  });

  it('rejects illegal and truncated GB18030 sequences instead of replacing them', () => {
    expect(() => decodeSample(Buffer.from([0x81]), 'gb18030')).toThrowError(
      expect.objectContaining({ code: 'INVALID_ENCODING' }),
    );
    expect(() => decodeSample(Buffer.from([0xff, 0x81]), 'gb18030', true)).toThrowError(
      expect.objectContaining({ code: 'INVALID_ENCODING' }),
    );
    expect(decodeSample(Buffer.from([0x81]), 'gb18030', true)).toBe('');
  });

  it('chooses the most consistent supported delimiter with deterministic ties', () => {
    expect(detectDelimiter('a\tb\n1\t2\n')).toBe('\t');
    expect(detectDelimiter('a;b;c\n1;2;3\n4;5\n')).toBe(';');
    expect(detectDelimiter('single\nvalue\n')).toBe(',');
  });

  it('suggests headers while leaving ordinary headerless records alone', () => {
    expect(detectSample(Buffer.from('name,notes\nA,x\n')).hasHeader).toBe(true);
    expect(detectSample(Buffer.from('A,1\nB,2\n')).hasHeader).toBe(false);
  });
});
