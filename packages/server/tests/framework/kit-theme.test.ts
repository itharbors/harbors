import { describe, expect, it } from 'vitest';
import { normalizeKitTheme } from '../../src/framework/kit/theme';

describe('normalizeKitTheme', () => {
  it('returns undefined for a missing theme', () => {
    expect(normalizeKitTheme(undefined, '@example/kit')).toBeUndefined();
  });

  it('returns a copied valid theme', () => {
    expect(normalizeKitTheme({ '--ce-accent': '#55aaff' }, '@example/kit'))
      .toEqual({ '--ce-accent': '#55aaff' });
  });

  it.each([
    [[], 'theme must be an object'],
    [{ accent: '#55aaff' }, 'invalid theme token "accent"'],
    [{ '--ce-accent': 42 }, 'theme token "--ce-accent" must be a string'],
  ])('rejects invalid theme input %#', (input, message) => {
    expect(() => normalizeKitTheme(input, '@example/kit')).toThrow(message);
  });
});
