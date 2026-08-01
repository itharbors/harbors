import { describe, expect, it } from 'vitest';

import {
  parseRepositoryKitPackage,
  SUPPORTED_KIT_RUNNERS,
  type RepositoryKitPackageMetadata,
} from '../src/index.js';

const validHarbors = {
  distribution: 'market',
  ci: { runner: 'ubuntu-latest' },
  docs: { summary: 'Product summary' },
  resources: [],
  storage: { legacyDataDirectories: [] },
  scripts: {
    build: 'build',
    test: 'test:kit',
    smoke: 'smoke',
  },
} as const;

describe('SUPPORTED_KIT_RUNNERS', () => {
  it('exposes the exact supported runner set in lexical order', () => {
    expect(SUPPORTED_KIT_RUNNERS).toEqual(['macos-14', 'ubuntu-latest']);
  });
});

describe('parseRepositoryKitPackage', () => {
  it('parses a valid market harbors block and freezes the result', () => {
    const metadata = parseRepositoryKitPackage(validHarbors);

    expect(metadata).toEqual({
      distribution: 'market',
      ciRunner: 'ubuntu-latest',
      summary: 'Product summary',
      scripts: { build: 'build', test: 'test:kit', smoke: 'smoke' },
      resources: [],
      legacyDataDirectories: [],
    });
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.isFrozen(metadata.scripts)).toBe(true);
    expect(Object.isFrozen(metadata.resources)).toBe(true);
    expect(Object.isFrozen(metadata.legacyDataDirectories)).toBe(true);
  });

  it('accepts a builtin distribution', () => {
    const metadata = parseRepositoryKitPackage({
      ...validHarbors,
      distribution: 'builtin',
    });

    expect(metadata.distribution).toBe('builtin');
  });

  it('omits smoke when not declared', () => {
    const metadata = parseRepositoryKitPackage({
      ...validHarbors,
      scripts: { build: 'build', test: 'test:kit' },
    });

    expect(metadata.scripts).toEqual({ build: 'build', test: 'test:kit' });
    expect('smoke' in metadata.scripts).toBe(false);
  });

  it('accepts optional resources and legacy data directories', () => {
    const metadata = parseRepositoryKitPackage({
      ...validHarbors,
      resources: ['plugins/demo/main/dist', 'resources/icon.png'],
      storage: { legacyDataDirectories: ['agent-guard', 'scheduler'] },
    });

    expect(metadata.resources).toEqual(['plugins/demo/main/dist', 'resources/icon.png']);
    expect(metadata.legacyDataDirectories).toEqual(['agent-guard', 'scheduler']);
  });

  it('rejects unknown harbors fields', () => {
    expect(() => parseRepositoryKitPackage({ ...validHarbors, extra: true })).toThrow(
      /unexpected field extra/u,
    );
  });

  it('rejects an unsupported distribution', () => {
    expect(() => parseRepositoryKitPackage({ ...validHarbors, distribution: 'custom' })).toThrow(
      /harbors.distribution must be one of/u,
    );
  });

  it('rejects an unsupported CI runner', () => {
    expect(() => parseRepositoryKitPackage({
      ...validHarbors,
      ci: { runner: 'windows-latest' },
    })).toThrow(/harbors.ci.runner must be one of/u);
  });

  it('rejects a missing build script', () => {
    expect(() => parseRepositoryKitPackage({
      ...validHarbors,
      scripts: { test: 'test:kit' },
    })).toThrow(/harbors.scripts.build/u);
  });

  it('rejects a missing test script', () => {
    expect(() => parseRepositoryKitPackage({
      ...validHarbors,
      scripts: { build: 'build' },
    })).toThrow(/harbors.scripts.test/u);
  });

  it('rejects an unknown script key', () => {
    expect(() => parseRepositoryKitPackage({
      ...validHarbors,
      scripts: { build: 'build', test: 'test:kit', lint: 'lint' },
    })).toThrow(/unexpected field lint/u);
  });

  it('rejects a resource that escapes the Kit root', () => {
    expect(() => parseRepositoryKitPackage({
      ...validHarbors,
      resources: ['../escape'],
    })).toThrow(/harbors.resources\[0\] must be a normalized Kit-relative path/u);
  });

  it('rejects an absolute resource path', () => {
    expect(() => parseRepositoryKitPackage({
      ...validHarbors,
      resources: ['/etc/passwd'],
    })).toThrow(/harbors.resources\[0\] must be a Kit-relative path/u);
  });

  it('rejects a resource with a backslash', () => {
    expect(() => parseRepositoryKitPackage({
      ...validHarbors,
      resources: ['plugins\\demo'],
    })).toThrow(/harbors.resources\[0\] must be a Kit-relative path/u);
  });

  it('rejects duplicate resources', () => {
    expect(() => parseRepositoryKitPackage({
      ...validHarbors,
      resources: ['a', 'a'],
    })).toThrow(/harbors.resources contains duplicate values/u);
  });

  it('rejects a legacy data directory with a separator', () => {
    expect(() => parseRepositoryKitPackage({
      ...validHarbors,
      storage: { legacyDataDirectories: ['a/b'] },
    })).toThrow(/harbors.storage.legacyDataDirectories\[0\] must be a single canonical directory name/u);
  });

  it('rejects a legacy data directory dot segment', () => {
    expect(() => parseRepositoryKitPackage({
      ...validHarbors,
      storage: { legacyDataDirectories: ['..'] },
    })).toThrow(/harbors.storage.legacyDataDirectories\[0\] must be a single canonical directory name/u);
  });

  it('rejects a legacy data directory containing a NUL byte', () => {
    expect(() => parseRepositoryKitPackage({
      ...validHarbors,
      storage: { legacyDataDirectories: ['a\0b'] },
    })).toThrow(/harbors.storage.legacyDataDirectories\[0\] must be a single canonical directory name/u);
  });

  it('rejects duplicate legacy data directories', () => {
    expect(() => parseRepositoryKitPackage({
      ...validHarbors,
      storage: { legacyDataDirectories: ['a', 'a'] },
    })).toThrow(/harbors.storage.legacyDataDirectories contains duplicate values/u);
  });

  it('rejects a non-object harbors value', () => {
    expect(() => parseRepositoryKitPackage(null)).toThrow(/harbors must be an object/u);
  });

  it('returns a frozen metadata object', () => {
    const metadata = parseRepositoryKitPackage(validHarbors) as RepositoryKitPackageMetadata;
    expect(() => {
      (metadata as { distribution: string }).distribution = 'builtin';
    }).toThrow();
  });
});
