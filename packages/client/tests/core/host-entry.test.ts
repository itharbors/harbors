import { describe, expect, it } from 'vitest';
import { isKitCatalogResponse, selectHostEntry } from '../../src/core/host-entry';

describe('host entry selection', () => {
  it('shows the chooser only for the bare multi-Kit root', () => {
    expect(selectHostEntry('multi', new URL('http://localhost:8080/'))).toBe('picker');
    expect(selectHostEntry('multi', new URL('http://localhost:8080/?kit=%40itharbors%2Fkit-mysql')))
      .toBe('editor');
    expect(selectHostEntry('multi', new URL('http://localhost:8080/?session=existing')))
      .toBe('editor');
    expect(selectHostEntry('multi', new URL('http://localhost:8080/?sessionId=existing')))
      .toBe('editor');
    expect(selectHostEntry(
      'multi',
      new URL('http://localhost:8080/?session=existing&kit=%2Frepo%2Fkits%2Fmysql&menuMode=multi'),
    )).toBe('editor');
    expect(selectHostEntry('multi', new URL('http://localhost:8080/?page=layout-kit')))
      .toBe('editor');
  });

  it('always opens the editor in single-Kit mode', () => {
    expect(selectHostEntry('single', new URL('http://localhost:8080/'))).toBe('editor');
  });

  it('validates the public catalog shape before using it', () => {
    expect(isKitCatalogResponse({
      mode: 'multi',
      kits: [{ id: 'mysql', name: '@itharbors/kit-mysql', label: 'MySQL' }],
    })).toBe(true);
    expect(isKitCatalogResponse({
      mode: 'multi',
      kits: [{ id: 'mysql', name: '@itharbors/kit-mysql', label: 'MySQL', directory: '/private' }],
    })).toBe(true);
    expect(isKitCatalogResponse({ mode: 'many', kits: [] })).toBe(false);
    expect(isKitCatalogResponse({ mode: 'multi', kits: [{ id: '', name: 'x', label: 'X' }] }))
      .toBe(false);
    expect(isKitCatalogResponse(null)).toBe(false);
  });
});
