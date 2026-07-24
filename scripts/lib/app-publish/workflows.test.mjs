import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const rootUrl = new URL('../../../', import.meta.url);
const wrapperUrl = new URL('.github/workflows/publish-app.yml', rootUrl);
const reusableUrl = new URL('.github/workflows/publish-app-reusable.yml', rootUrl);
const packageUrl = new URL('package.json', rootUrl);

test('app publish wrapper only dispatches app/v* tags through the locked reusable workflow', async () => {
  const wrapper = await readFile(wrapperUrl, 'utf8');

  assert.match(wrapper, /^on:\s*\n\s+push:\s*\n\s+tags:\s*\n\s+- ['"]app\/v\*['"]\s*$/mu);
  assert.doesNotMatch(wrapper, /workflow_dispatch|branches:|paths:|kit\/v|@main/u);
  assert.match(wrapper, /uses:\s*itharbors\/harbors\/\.github\/workflows\/publish-app-reusable\.yml@app-publish-v1/u);
  assert.doesNotMatch(wrapper, /uses:.*@refs\/tags\/app-publish-v1/u);
  assert.match(wrapper, /contents:\s*write/u);
  assert.match(wrapper, /id-token:\s*write/u);
  assert.match(wrapper, /attestations:\s*write/u);
  assert.match(wrapper, /secrets:\s*inherit/u);
});

test('reusable workflow locks caller and signer identities with GitHub reference semantics', async () => {
  const workflow = await readFile(reusableUrl, 'utf8');
  const context = workflowJob(workflow, 'context');

  assert.match(workflow, /^on:\s*\n\s+workflow_call:\s*$/mu);
  assert.match(context, /GITHUB_REPOSITORY/u);
  assert.match(context, /\.github\/workflows\/publish-app\.yml@\$GITHUB_REF/u);
  assert.match(workflow, /itharbors\/harbors\/\.github\/workflows\/publish-app-reusable\.yml@refs\/tags\/app-publish-v1/u);
  assert.doesNotMatch(workflow, /publish-app-reusable\.yml@main/u);
});

test('context validates the exact canonical release commit from full history on origin/main', async () => {
  const workflow = await readFile(reusableUrl, 'utf8');
  const context = workflowJob(workflow, 'context');

  assert.match(context, /actions\/checkout@v6/u);
  assert.match(context, /ref:\s*\$\{\{ github\.ref \}\}/u);
  assert.match(context, /fetch-depth:\s*0/u);
  assert.match(context, /persist-credentials:\s*false/u);
  assert.match(context, /git fetch --no-tags origin main/u);
  assert.match(context, /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/u);
  assert.match(context, /git rev-parse HEAD/u);
  assert.match(context, /validateAppReleaseIdentity/u);
  assert.match(context, /packages\/desktop\/package\.json/u);
  assert.match(context, /refs\/tags\/\$\{identity\.tag\}/u);
  assert.match(context, /version:\s*\$\{\{ steps\.identity\.outputs\.version \}\}/u);
  assert.match(context, /channel:\s*\$\{\{ steps\.identity\.outputs\.channel \}\}/u);
  assert.match(context, /tag:\s*\$\{\{ steps\.identity\.outputs\.tag \}\}/u);
  assert.doesNotMatch(context, /steps\.identity\.outputs\.(ref|sha|secret)/u);
});

test('release runs on pinned macOS arm64 tooling after all checks and requires every signing secret', async () => {
  const workflow = await readFile(reusableUrl, 'utf8');
  const release = workflowJob(workflow, 'release');

  assert.match(release, /runs-on:\s*macos-15/u);
  assert.match(release, /environment:\s*app-\$\{\{ needs\.context\.outputs\.channel \}\}/u);
  assert.match(release, /actions\/setup-node@v6[\s\S]*node-version:\s*22\.18\.0/u);
  assert.match(release, /npm install --global npm@10\.9\.3/u);
  assert.match(release, /uname -m[\s\S]*arm64/u);

  const installIndex = release.indexOf('run: npm ci');
  const checkIndex = release.indexOf('run: npm run check');
  const buildIndex = release.indexOf('npm run desktop:dist');
  assert.ok(installIndex !== -1 && checkIndex > installIndex && buildIndex > checkIndex);

  for (const secret of [
    'MAC_CSC_LINK',
    'MAC_CSC_KEY_PASSWORD',
    'APPLE_API_KEY',
    'APPLE_API_KEY_ID',
    'APPLE_API_ISSUER',
    'APPLE_TEAM_ID',
  ]) {
    assert.match(release, new RegExp(`secrets\\.${secret}`, 'u'));
  }
  assert.match(release, /for secret_name in MAC_CSC_LINK MAC_CSC_KEY_PASSWORD APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER APPLE_TEAM_ID/u);
  assert.match(release, /-z "\$\{!secret_name\}"/u);
  assert.doesNotMatch(release, /ad[- ]?hoc|unsigned|CSC_IDENTITY_AUTO_DISCOVERY:\s*false/u);
});

test('release verifies Developer ID signing, notarization, arm64, and an isolated healthy startup', async () => {
  const release = workflowJob(await readFile(reusableUrl, 'utf8'), 'release');

  assert.match(release, /codesign -dv --verbose=4/u);
  assert.match(release, /Authority=Developer ID Application:/u);
  assert.match(release, /TeamIdentifier=\$APPLE_TEAM_ID/u);
  assert.match(release, /codesign --verify --deep --strict --verbose=2/u);
  assert.match(release, /spctl --assess --type execute --verbose=4/u);
  assert.match(release, /xcrun stapler validate/u);
  assert.match(release, /EXECUTABLE=.*Contents\/MacOS[\s\S]*file "\$EXECUTABLE"/u);
  assert.match(release, /arm64/u);
  assert.match(release, /mktemp -d/u);
  assert.match(release, /--user-data-dir/u);
  assert.match(release, /HARBORS_DISABLE_UPDATE_CHECKS/u);
  assert.match(release, /\/api\/health/u);
  assert.match(release, /kill .*APP_PID/u);
});

test('release selects exactly six nonempty assets and generates checksums plus SPDX SBOM', async () => {
  const release = workflowJob(await readFile(reusableUrl, 'utf8'), 'release');

  assert.match(release, /npm sbom --sbom-format spdx/u);
  assert.match(release, /shasum -a 256/u);
  assert.match(release, /ITHARBORS-\$RELEASE_VERSION-arm64\.dmg/u);
  assert.match(release, /ITHARBORS-\$RELEASE_VERSION-arm64\.zip/u);
  assert.match(release, /ITHARBORS-\$RELEASE_VERSION-arm64\.zip\.blockmap/u);
  assert.match(release, /latest-mac\.yml/u);
  assert.match(release, /checksums\.txt/u);
  assert.match(release, /sbom\.spdx\.json/u);
  assert.match(release, /\$\{#ASSETS\[@\]\}.*-ne 6/u);
  assert.match(release, /! -s "\$asset"/u);
});

test('publication attests all assets and safely verifies a new draft before publishing once', async () => {
  const release = workflowJob(await readFile(reusableUrl, 'utf8'), 'release');

  assert.match(release, /actions\/attest@v4/u);
  assert.match(release, /subject-path:[\s\S]*\.dmg[\s\S]*\.zip[\s\S]*\.zip\.blockmap[\s\S]*latest-mac\.yml[\s\S]*checksums\.txt[\s\S]*sbom\.spdx\.json/u);
  assert.match(release, /releases\/tags\/\$RELEASE_TAG/u);
  assert.match(release, /already exists/u);
  assert.match(release, /draft=true/u);
  assert.match(release, /DRAFT_ID/u);
  assert.match(release, /trap cleanup EXIT/u);
  assert.match(release, /release\.draft !== true/u);
  assert.match(release, /release\.tag_name !== process\.env\.RELEASE_TAG/u);
  assert.match(release, /--method DELETE/u);
  assert.match(release, /actualNames[\s\S]*\.sort/u);
  assert.match(release, /expectedNames[\s\S]*\.sort/u);
  assert.match(release, /asset\.size <= 0/u);
  assert.equal((release.match(/--draft=false/gu) ?? []).length, 1, 'draft must be published exactly once');
  assert.match(release, /publish_args\+=\(--prerelease\)/u);
  assert.match(release, /needs\.context\.outputs\.channel == 'preview'/u);
});

test('root test scripts register the focused app publish workflow suite', async () => {
  const packageJson = JSON.parse(await readFile(packageUrl, 'utf8'));

  assert.equal(
    packageJson.scripts['test:app-publish'],
    'node --test scripts/lib/app-publish/*.test.mjs',
  );
  assert.match(packageJson.scripts.test, /npm run test:app-publish/u);
});

function workflowJob(workflow, name) {
  const marker = `\n  ${name}:\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `workflow must contain ${name} job`);
  const remainder = workflow.slice(start + marker.length);
  const next = remainder.search(/^  [a-z][a-z0-9-]*:\n/mu);
  return next === -1 ? remainder : remainder.slice(0, next);
}
