import { OFFICIAL_KIT_SLUGS } from './kit-monorepo.mjs';

const SHARED_PREFIXES = Object.freeze([
  'packages/kit-core/',
  'packages/kit-cli/',
  'scripts/lib/kit-check.',
  'scripts/lib/kit-monorepo.',
  'scripts/lib/kit-publish/',
  'scripts/lib/kit-registry/',
]);

const SHARED_FILES = new Set([
  'package.json',
  'package-lock.json',
  'registry/policy.json',
  'registry/revocations.json',
  'scripts/check-kit.mjs',
  'scripts/kit-publish.mjs',
  'scripts/select-kit-ci.mjs',
  'scripts/lib/kit-ci-selection.mjs',
  '.github/workflows/kit-ci.yml',
  '.github/workflows/publish-kit.yml',
  '.github/workflows/publish-kit-reusable.yml',
  '.github/workflows/publish-kit-registry.yml',
]);

const UNSAFE_PATH_CHARACTERS = /[\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:\//u;

function assertCanonicalRepositoryPath(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.startsWith('/')
    || WINDOWS_ABSOLUTE_PATH.test(value)
    || UNSAFE_PATH_CHARACTERS.test(value)
  ) {
    throw new Error('Changed path must be a canonical repository path');
  }
  const parts = value.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('Changed path must be a canonical repository path');
  }
  return parts;
}

export function selectKitSlugs(paths) {
  if (!Array.isArray(paths)) throw new TypeError('paths must be an array');
  const selected = new Set();
  for (const value of paths) {
    const parts = assertCanonicalRepositoryPath(value);
    if (SHARED_FILES.has(value) || SHARED_PREFIXES.some((prefix) => value.startsWith(prefix))) {
      for (const slug of OFFICIAL_KIT_SLUGS) selected.add(slug);
      continue;
    }
    if (parts[0] !== 'kits' || parts.length === 1) continue;
    const slug = parts[1];
    if (!OFFICIAL_KIT_SLUGS.includes(slug)) {
      if (slug !== 'default') throw new Error(`Unknown Kit directory: ${slug}`);
      continue;
    }
    selected.add(slug);
  }
  return [...selected].sort();
}
