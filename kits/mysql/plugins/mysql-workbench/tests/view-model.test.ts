// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  createRecordDraft,
  editableValueFromInput,
  formatValue,
} from '../panel.workbench/src/view-model';

describe('MySQL workbench view model', () => {
  it('formats protocol values without dropping type cues', () => {
    expect(formatValue(null)).toBe('NULL');
    expect(formatValue({ type: 'integer', mysqlType: 'BIGINT', value: '9007199254740993' }))
      .toBe('9007199254740993');
    expect(formatValue({ type: 'decimal', value: '12.3400' })).toBe('12.3400');
    expect(formatValue({ type: 'datetime', value: '2026-07-19 10:20:30' }))
      .toBe('2026-07-19 10:20:30');
    expect(formatValue({ type: 'json', value: '{"ok":true}' })).toBe('{"ok":true}');
    expect(formatValue({ type: 'blob', size: 12, previewHex: '00ff' }))
      .toBe('BLOB · 12 B · 00ff…');
    expect(formatValue(true)).toBe('TRUE');
  });

  it('keeps explicit form types and validates their lexical form', () => {
    expect(editableValueFromInput('null', '')).toEqual({ type: 'null' });
    expect(editableValueFromInput('integer', '0042')).toEqual({ type: 'integer', value: '0042' });
    expect(editableValueFromInput('decimal', '12.3400')).toEqual({ type: 'decimal', value: '12.3400' });
    expect(editableValueFromInput('datetime', '2026-07-19 10:20:30')).toEqual({
      type: 'datetime', value: '2026-07-19 10:20:30',
    });
    expect(() => editableValueFromInput('integer', '4.2')).toThrow(/integer/i);
    expect(() => editableValueFromInput('json', '{bad')).toThrow(/JSON/);
  });

  it('builds add/edit drafts while omitting generated and binary fields', () => {
    const columns = [
      { name: 'id', type: 'bigint', nullable: false, defaultValue: null, generated: false, autoIncrement: true, binary: false },
      { name: 'email', type: 'varchar(255)', nullable: false, defaultValue: null, generated: false, autoIncrement: false, binary: false },
      { name: 'score', type: 'decimal(10,2)', nullable: true, defaultValue: '0.00', generated: false, autoIncrement: false, binary: false },
      { name: 'created_at', type: 'datetime', nullable: false, defaultValue: null, generated: false, autoIncrement: false, binary: false },
      { name: 'payload', type: 'blob', nullable: true, defaultValue: null, generated: false, autoIncrement: false, binary: true },
      { name: 'search_text', type: 'text', nullable: true, defaultValue: null, generated: true, autoIncrement: false, binary: false },
    ];

    expect(createRecordDraft(columns)).toEqual([
      expect.objectContaining({ name: 'id', inputType: 'integer', included: false }),
      expect.objectContaining({ name: 'email', inputType: 'text', included: true }),
      expect.objectContaining({ name: 'score', inputType: 'decimal', included: false }),
      expect.objectContaining({ name: 'created_at', inputType: 'datetime', included: true }),
    ]);

    expect(createRecordDraft(columns, [
      { type: 'integer', mysqlType: 'BIGINT', value: '7' },
      'a@example.com',
      { type: 'decimal', value: '2.50' },
      { type: 'datetime', value: '2026-07-19 10:20:30' },
      { type: 'blob', size: 2, previewHex: '00ff' },
      'generated',
    ])).toEqual([
      expect.objectContaining({ name: 'id', value: '7', included: true }),
      expect.objectContaining({ name: 'email', value: 'a@example.com', included: true }),
      expect.objectContaining({ name: 'score', value: '2.50', included: true }),
      expect.objectContaining({ name: 'created_at', value: '2026-07-19 10:20:30', included: true }),
    ]);
  });
});
