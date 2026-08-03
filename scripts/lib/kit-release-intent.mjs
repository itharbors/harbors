import semver from 'semver';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const UNSAFE_PATH = /[\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function pathParts(value) {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('/') || UNSAFE_PATH.test(value)) {
    throw new Error('Changed path must be a canonical repository path');
  }
  const parts = value.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('Changed path must be a canonical repository path');
  }
  return parts;
}

function marketSlugs(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || !policy.kits || typeof policy.kits !== 'object' || Array.isArray(policy.kits)) {
    throw new Error('Registry policy must contain a kits object');
  }
  const slugs = Object.keys(policy.kits).sort();
  for (const slug of slugs) {
    if (!SLUG_PATTERN.test(slug) || policy.kits[slug]?.id !== `@itharbors/kit-${slug}`) {
      throw new Error(`Registry policy identity mismatch for ${slug}`);
    }
  }
  return new Set(slugs);
}

function validateProduct(slug, product) {
  if (!product || typeof product !== 'object') throw new Error(`Market Kit ${slug} is missing at the head revision`);
  const expectedId = `@itharbors/kit-${slug}`;
  const { manifest, packageJson, lockfile } = product;
  if (manifest?.id !== expectedId || packageJson?.name !== expectedId) {
    throw new Error(`Kit identity mismatch for ${slug}: expected ${expectedId}`);
  }
  if (manifest.version !== packageJson.version) {
    throw new Error(`Kit versions do not match for ${slug}`);
  }
  const version = manifest.version;
  if (typeof version !== 'string' || semver.valid(version) !== version || version.includes('+')) {
    throw new Error(`Kit version must be canonical SemVer without build metadata for ${slug}: ${String(version)}`);
  }
  const root = lockfile?.packages?.[''];
  if (root?.name !== expectedId || root?.version !== version) {
    throw new Error(`Kit lockfile identity does not match package.json for ${slug}`);
  }
  const channel = semver.prerelease(version) === null ? 'stable' : 'preview';
  if (manifest.channel !== channel) {
    throw new Error(`Kit channel must be ${channel} for ${slug} ${version}`);
  }
  return { version, channel };
}

function freezePlan(entries) {
  for (const entry of entries) Object.freeze(entry);
  return Object.freeze(entries);
}

export function createKitReleasePlan({ changedPaths, policy, baseProducts, headProducts }) {
  if (!Array.isArray(changedPaths)) throw new TypeError('changedPaths must be an array');
  if (!(baseProducts instanceof Map) || !(headProducts instanceof Map)) {
    throw new TypeError('baseProducts and headProducts must be Maps');
  }
  const published = marketSlugs(policy);
  const changed = new Set();
  for (const value of changedPaths) {
    const parts = pathParts(value);
    if (parts[0] === 'kits' && parts.length > 2 && published.has(parts[1])) changed.add(parts[1]);
  }

  const plan = [];
  for (const slug of [...changed].sort()) {
    const current = validateProduct(slug, headProducts.get(slug));
    const previousProduct = baseProducts.get(slug);
    if (previousProduct) {
      const previous = validateProduct(slug, previousProduct);
      if (!semver.gt(current.version, previous.version)) {
        throw new Error(`Kit version for ${slug} must increase from ${previous.version}, got ${current.version}`);
      }
    }
    plan.push({
      slug,
      version: current.version,
      channel: current.channel,
      tag: `kit/${slug}/v${current.version}`,
    });
  }
  return freezePlan(plan);
}
