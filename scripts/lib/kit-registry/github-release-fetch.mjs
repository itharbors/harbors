const GITHUB_RELEASE_PATH = /^\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/releases\/download\/[^/]+\/[^/]+$/u;

export class GitHubReleaseFetchError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'GitHubReleaseFetchError';
    this.code = code;
  }
}

export function assertGitHubReleaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new GitHubReleaseFetchError('INVALID_RELEASE_URL', 'URL must identify a GitHub Release asset', {
      cause: error,
    });
  }
  if (
    url.protocol !== 'https:'
    || url.hostname !== 'github.com'
    || url.username
    || url.password
    || url.search
    || url.hash
    || !GITHUB_RELEASE_PATH.test(url.pathname)
  ) {
    throw new GitHubReleaseFetchError('INVALID_RELEASE_URL', 'URL must identify a GitHub Release asset');
  }
  return url.href;
}

function assertTrustedRedirect(response) {
  if (response?.redirected !== true) return;
  let url;
  try {
    url = new URL(response.url);
  } catch (error) {
    throw new GitHubReleaseFetchError('UNTRUSTED_REDIRECT', 'GitHub Release redirect is invalid', {
      cause: error,
    });
  }
  const githubContent = url.hostname === 'githubusercontent.com'
    || url.hostname.endsWith('.githubusercontent.com');
  if (url.protocol !== 'https:' || !githubContent || url.username || url.password) {
    throw new GitHubReleaseFetchError(
      'UNTRUSTED_REDIRECT',
      'GitHub Release redirect left official GitHub content hosting',
    );
  }
}

export async function fetchGitHubReleaseAsset(fetchImpl, url, init = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  const response = await fetchImpl(assertGitHubReleaseUrl(url), {
    ...init,
    redirect: 'follow',
  });
  assertTrustedRedirect(response);
  return response;
}
