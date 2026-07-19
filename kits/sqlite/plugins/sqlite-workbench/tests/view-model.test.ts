// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  createRecordDraft,
  editableValueFromInput,
  formatValue,
} from '../panel.workbench/src/view-model';

describe('SQLite workbench view model', () => {
  it('formats protocol values without losing type cues', () => {
    expect(formatValue(null)).toBe('NULL');
    expect(formatValue({ type: 'integer', value: '9007199254740993' }))
      .toBe('9007199254740993');
    expect(formatValue({ type: 'blob', size: 12, previewHex: '00ff' }))
      .toBe('BLOB · 12 B · 00ff…');
    expect(formatValue('')).toBe('');
    expect(formatValue(4.25)).toBe('4.25');
  });

  it('keeps NULL, text, integer, and real form values explicit', () => {
    expect(editableValueFromInput('null', '')).toEqual({ type: 'null' });
    expect(editableValueFromInput('text', '0042')).toEqual({ type: 'text', value: '0042' });
    expect(editableValueFromInput('integer', '-42')).toEqual({ type: 'integer', value: '-42' });
    expect(editableValueFromInput('real', '4.25')).toEqual({ type: 'real', value: '4.25' });
    expect(() => editableValueFromInput('integer', '4.2')).toThrow('请输入十进制整数');
    expect(() => editableValueFromInput('real', 'Infinity')).toThrow('请输入有限实数');
  });

  it('creates editable drafts while omitting generated and BLOB fields', () => {
    const columns = [
      { name: 'id', type: 'INTEGER', hidden: false, generated: false },
      { name: 'label', type: 'TEXT', hidden: false, generated: false },
      { name: 'score', type: 'REAL', hidden: false, generated: false },
      { name: 'payload', type: 'BLOB', hidden: false, generated: false },
      { name: 'search_text', type: 'TEXT', hidden: true, generated: true },
    ];
    const row = [
      { type: 'integer' as const, value: '7' },
      null,
      3.5,
      { type: 'blob' as const, size: 2, previewHex: '00ff' },
      'generated',
    ];

    expect(createRecordDraft(columns, row)).toEqual([
      { name: 'id', affinity: 'INTEGER', inputType: 'integer', value: '7' },
      { name: 'label', affinity: 'TEXT', inputType: 'null', value: '' },
      { name: 'score', affinity: 'REAL', inputType: 'real', value: '3.5' },
    ]);
  });
});
