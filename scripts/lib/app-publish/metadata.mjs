import semver from 'semver';

const APP_RELEASE_REF = /^refs\/tags\/app\/v(.+)$/u;

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
    throw new Error('App release requires refs/tags/app/v<canonical-semver> without build metadata');
  }

  const version = match[1];
  try {
    assertCanonicalAppVersion(version, 'App release');
  } catch {
    throw new Error('App release requires refs/tags/app/v<canonical-semver> without build metadata');
  }

  return {
    version,
    channel: semver.prerelease(version) === null ? 'stable' : 'preview',
    tag: `app/v${version}`,
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
