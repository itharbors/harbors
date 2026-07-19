// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDownload, rowsToCsv } from '../panel.data/src/export';

describe('SQLite panel export helpers', () => {
  afterEach(() => vi.restoreAllMocks());

  it('quotes CSV values and preserves protocol value cues', () => {
    expect(rowsToCsv(['id', 'label', 'note', 'payload'], [[
      { type: 'integer', value: '9007199254740993' },
      'A, "quoted"',
      null,
      { type: 'blob', size: 2, previewHex: '00ff' },
    ]])).toBe('id,label,note,payload\r\n9007199254740993,"A, ""quoted""",,00ff');
  });

  it('creates and revokes a temporary object URL', () => {
    const createObjectURL = vi.fn(() => 'blob:sqlite-export');
    const revokeObjectURL = vi.fn();
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: createObjectURL },
      revokeObjectURL: { configurable: true, value: revokeObjectURL },
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    createDownload('rows.csv', 'text/csv', 'id\r\n1');

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:sqlite-export');
  });
});
