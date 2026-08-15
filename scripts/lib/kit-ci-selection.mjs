const SHARED_PREFIXES = Object.freeze([
  'packages/',
  'scripts/',
  '.github/workflows/',
]);

const SHARED_FILES = new Set(['package.json', 'package-lock.json', 'tsconfig.json']);
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/u;
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

function normalizeDescriptors(descriptors) {
  if (!Array.isArray(descriptors)) throw new TypeError('descriptors must be an array');
  const bySlug = new Map();
  for (const descriptor of descriptors) {
    if (!descriptor || typeof descriptor !== 'object' || typeof descriptor.slug !== 'string' || !SLUG_PATTERN.test(descriptor.slug)) {
      throw new Error('descriptors must contain canonical Kit descriptors');
    }
    if (bySlug.has(descriptor.slug)) throw new Error(`descriptors contains duplicate slug: ${descriptor.slug}`);
    bySlug.set(descriptor.slug, descriptor);
  }
  return [...bySlug.values()].sort((left, right) => left.slug.localeCompare(right.slug));
}

export function selectKitSlugs(paths, descriptors) {
  if (!Array.isArray(paths)) throw new TypeError('paths must be an array');
  const allDescriptors = normalizeDescriptors(descriptors);
  const bySlug = new Map(allDescriptors.map((descriptor) => [descriptor.slug, descriptor]));
  const selected = new Set();
  for (const value of paths) {
    const parts = assertCanonicalRepositoryPath(value);
    if (SHARED_FILES.has(value) || SHARED_PREFIXES.some((prefix) => value.startsWith(prefix))) {
      for (const descriptor of allDescriptors) selected.add(descriptor.slug);
      continue;
    }
    if (parts[0] !== 'kits' || parts.length === 1) continue;
    const slug = parts[1];
    if (!bySlug.has(slug)) throw new Error(`Unknown Kit directory: ${slug}`);
    selected.add(slug);
  }
  return [...selected].sort();
}
