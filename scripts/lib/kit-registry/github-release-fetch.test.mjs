import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchGitHubReleaseAsset } from './github-release-fetch.mjs';

const releaseUrl = 'https://github.com/itharbors/harbors/releases/download/kit%2Fmysql%2Fv1.2.3/release.json';

test('follows a GitHub Release redirect only to the official GitHub content domain', async () => {
  const calls = [];
  const response = {
    ok: true,
    redirected: true,
    url: 'https://release-assets.githubusercontent.com/github-production-release-asset/example',
  };
  const result = await fetchGitHubReleaseAsset(async (url, init) => {
    calls.push({ url, init });
    return response;
  }, releaseUrl, { method: 'GET', headers: { Accept: 'application/json' } });
  assert.equal(result, response);
  assert.equal(calls[0].init.redirect, 'follow');
});

test('accepts a direct GitHub response without requiring synthetic redirect metadata', async () => {
  const response = new Response('{}');
  assert.equal(
    await fetchGitHubReleaseAsset(async () => response, releaseUrl, { method: 'GET' }),
    response,
  );
});

test('rejects non-GitHub initial URLs and redirects outside GitHub content hosting', async () => {
  let calls = 0;
  await assert.rejects(
    () => fetchGitHubReleaseAsset(async () => { calls += 1; }, 'https://example.test/kit.hkit'),
    /GitHub Release/u,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    () => fetchGitHubReleaseAsset(async () => ({
      redirected: true,
      url: 'https://example.test/redirected-kit.hkit',
    }), releaseUrl),
    /redirect/u,
  );
});

test('rejects credentials, query injection, and malformed GitHub Release paths', async () => {
  for (const url of [
    'https://user@github.com/itharbors/harbors/releases/download/v1/kit.hkit',
    'https://github.com/itharbors/harbors/releases/download/v1/kit.hkit?token=x',
    'https://github.com/itharbors/harbors/archive/v1.zip',
    'http://github.com/itharbors/harbors/releases/download/v1/kit.hkit',
  ]) {
    await assert.rejects(() => fetchGitHubReleaseAsset(async () => new Response('x'), url));
  }
});
