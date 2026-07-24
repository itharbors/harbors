import semver from 'semver';

const APP_RELEASE_REF = /^refs\/tags\/v(.+)$/u;

function assertCanonicalAppVersion(version, subject) {
  if (
    typeof version !== 'string'
    || semver.valid(version) !== version
    || version.includes('+')
  ) {
    throw new Error(`${subject} requires canonical SemVer without build metadata`);
  }
}

export function parseAppReleaseTag(ref) {
  const match = typeof ref === 'string' ? APP_RELEASE_REF.exec(ref) : null;
  if (!match) {
    throw new Error('App release requires refs/tags/v<canonical-semver> without build metadata');
  }

  const version = match[1];
  try {
    assertCanonicalAppVersion(version, 'App release');
  } catch {
    throw new Error('App release requires refs/tags/v<canonical-semver> without build metadata');
  }

  return {
    version,
    channel: semver.prerelease(version) === null ? 'stable' : 'preview',
    tag: `v${version}`,
  };
}

export function validateAppReleaseIdentity({ ref, packageVersion }) {
  const release = parseAppReleaseTag(ref);
  assertCanonicalAppVersion(packageVersion, 'Desktop package version');
  if (release.version !== packageVersion) {
    throw new Error(`App release tag version ${release.version} does not match desktop package version ${packageVersion}`);
  }
  return release;
}

export function validateAppUpdateMetadata({ metadata, zipName, dmgName }) {
  const expected = [zipName, dmgName].sort();
  const actual = Array.isArray(metadata?.files)
    ? metadata.files.map((file) => file?.url).sort()
    : [];
  if (
    typeof zipName !== 'string'
    || typeof dmgName !== 'string'
    || zipName === dmgName
    || actual.length !== 2
    || actual.some((url) => typeof url !== 'string')
    || JSON.stringify(actual) !== JSON.stringify(expected)
    || metadata?.path !== zipName
  ) {
    throw new Error('latest-mac.yml references an asset outside the exact allowlist');
  }
}
