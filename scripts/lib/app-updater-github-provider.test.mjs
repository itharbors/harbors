import assert from 'node:assert/strict';
import test from 'node:test';

import { GitHubProvider } from 'electron-updater/out/providers/GitHubProvider.js';
import semver from 'semver';

test('electron-updater discovers a Preview release from the canonical v<semver> GitHub tag', async () => {
  const feed = `<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>v1.2.3-preview.2</title>
        <link href="https://github.com/itharbors/harbors/releases/tag/v1.2.3-preview.2"/>
        <content>Preview 2</content>
      </entry>
    </feed>`;
  const updateMetadata = `version: 1.2.3-preview.2
files:
  - url: ITHARBORS-1.2.3-preview.2-arm64-mac.zip
    sha512: YWJj
path: ITHARBORS-1.2.3-preview.2-arm64-mac.zip
sha512: YWJj
`;
  const requests = [];
  const executor = {
    request(options) {
      requests.push(options.path);
      return Promise.resolve(requests.length === 1 ? feed : updateMetadata);
    },
  };
  const updater = {
    allowPrerelease: true,
    channel: null,
    currentVersion: new semver.SemVer('1.2.3-preview.1'),
    fullChangelog: false,
  };
  const provider = new GitHubProvider(
    { provider: 'github', owner: 'itharbors', repo: 'harbors' },
    updater,
    { platform: 'darwin', executor, isUseMultipleRangeRequest: false },
  );

  const result = await provider.getLatestVersion();

  assert.equal(result.tag, 'v1.2.3-preview.2');
  assert.equal(result.version, '1.2.3-preview.2');
  assert.deepEqual(requests, [
    '/itharbors/harbors/releases.atom',
    '/itharbors/harbors/releases/download/v1.2.3-preview.2/preview-mac.yml',
  ]);
});
