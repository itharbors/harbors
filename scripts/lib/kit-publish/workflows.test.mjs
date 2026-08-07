import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../../', import.meta.url);
const legacyRegistryBranch = ['kit', 'registry'].join('-');

async function read(relative) {
  return readFile(new URL(relative, root), 'utf8');
}

function jobBlock(workflow, name) {
  const marker = `\n  ${name}:\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing ${name} job`);
  const bodyStart = start + marker.length;
  const remainder = workflow.slice(bodyStart);
  const next = remainder.search(/^  [a-z][a-z0-9-]*:\n/mu);
  return next === -1 ? remainder : remainder.slice(0, next);
}

test('mainline caller normalizes exact Kit Tags for automatic publication and main recovery through immutable v4 workflows', async () => {
  const workflow = await read('.github/workflows/publish-kit.yml');
  assert.match(workflow, /^on:\n  push:\n    tags:\n      - ['"]kit\/\*\/v\*['"]\n  workflow_dispatch:\n    inputs:\n      release-tag:[\s\S]*required:\s*true[\s\S]*request-id:[\s\S]*required:\s*true/mu);
  assert.doesNotMatch(workflow, /^\s+(branches:|pull_request:)/mu);
  assert.match(workflow, /^run-name:\s*Publish Kit \$\{\{ inputs\['release-tag'\] \|\| github\.ref_name \}\} \$\{\{ inputs\['request-id'\] \|\| github\.run_id \}\}$/mu);
  assert.match(
    workflow,
    /uses:\s*itharbors\/harbors\/\.github\/workflows\/publish-kit-reusable\.yml@kit-publish-v4/u,
  );
  assert.match(workflow, /secrets:\s*inherit/u);
  const context = jobBlock(workflow, 'context');
  const preflight = jobBlock(workflow, 'preflight');
  const publish = jobBlock(workflow, 'publish');
  assert.match(context, /loadTrustedMarketKit/u);
  assert.match(context, /EXPECTED_TAG:\s*\$\{\{ inputs\['release-tag'\] \}\}/u);
  assert.match(context, /"\$GITHUB_REF" != "refs\/tags\/\$release_tag".*"\$GITHUB_REF" != refs\/heads\/main/u);
  assert.match(context, /release-tag=\$release_tag/u);
  assert.match(context, /actions\/checkout@v6[\s\S]*ref:\s*refs\/tags\/\$\{\{ steps\.release\.outputs\.release-tag \}\}/u);
  assert.match(context, /git cat-file -t "\$RELEASE_REF"/u);
  assert.match(context, /git rev-parse --verify "\$RELEASE_REF\^\{commit\}"/u);
  assert.match(context, /git merge-base --is-ancestor "\$release_commit" origin\/main/u);
  assert.match(context, /github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'/u);
  assert.match(context, /gh api "repos\/\$GITHUB_REPOSITORY\/releases\/tags\/\$RELEASE_TAG"/u);
  assert.match(context, /HTTP 404/u);
  assert.match(context, /runner=.*kit\.ciRunner/u);
  assert.match(preflight, /runs-on:\s*\$\{\{ needs\.context\.outputs\.runner \}\}/u);
  assert.match(preflight, /actions\/checkout@v6[\s\S]*ref:\s*refs\/tags\/\$\{\{ needs\.context\.outputs\.release-tag \}\}/u);
  assert.match(preflight, /npm run kits:boundary -- "\$KIT_NAME"/u);
  assert.match(preflight, /node scripts\/run-kit-matrix\.mjs check "\$KIT_NAME"/u);
  assert.match(publish, /needs:\s*\[context, preflight\]/u);
  assert.match(publish, /release-tag:\s*\$\{\{ needs\.context\.outputs\.release-tag \}\}/u);
  for (const permission of ['contents: write', 'id-token: write', 'attestations: write', 'pages: write']) {
    assert.match(workflow, new RegExp(permission, 'u'));
  }
});

test('main merge orchestrator validates all release intents before idempotent Tag creation and dispatch', async () => {
  const workflow = await read('.github/workflows/auto-publish-kit.yml');
  assert.match(workflow, /^on:\n  push:\n    branches:\n      - main$/mu);
  assert.match(workflow, /group:\s*automatic-kit-release[\s\S]*cancel-in-progress:\s*false/u);
  assert.match(workflow, /permissions:\n\s+contents:\s*write\n\s+actions:\s*write/u);
  assert.match(workflow, /actions\/checkout@v6[\s\S]*fetch-depth:\s*0/u);
  assert.match(workflow, /node scripts\/plan-kit-releases\.mjs "\$BASE_SHA" "\$HEAD_SHA"/u);
  assert.match(workflow, /RELEASES_JSON/u);
  assert.match(workflow, /gh api[\s\S]*git\/matching-refs\/tags/u);
  assert.match(workflow, /object\?\.type[\s\S]*object_type[\s\S]*commit/u);
  assert.match(workflow, /object\?\.sha[\s\S]*object_sha[\s\S]*HEAD_SHA/u);
  assert.match(workflow, /gh api "repos\/\$GITHUB_REPOSITORY\/releases\/tags\/\$tag"/u);
  assert.match(workflow, /release_error[\s\S]*HTTP 404[\s\S]*exit "\$release_status"/u);
  assert.match(workflow, /gh workflow run publish-kit\.yml[\s\S]*--ref "\$tag"[\s\S]*-f release-tag="\$tag"[\s\S]*-f request-id="\$request_id"/u);
  assert.doesNotMatch(workflow, /git tag -d|gh release delete|--force|--clobber/u);
});

test('mainline caller refreshes Registry through one correlated main dispatch after publication', async () => {
  const workflow = await read('.github/workflows/publish-kit.yml');
  const refresh = jobBlock(workflow, 'refresh-registry');
  assert.match(refresh, /needs:\s*publish/u);
  assert.match(refresh, /runs-on:\s*ubuntu-latest/u);
  assert.match(refresh, /permissions:\n\s+actions:\s*write/u);
  assert.match(refresh, /REQUEST_ID:\s*kit-release-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u);
  assert.match(
    refresh,
    /gh workflow run publish-kit-registry\.yml[\s\S]*--repo "\$GITHUB_REPOSITORY"[\s\S]*--ref main[\s\S]*-f request-id="\$REQUEST_ID"/u,
  );
  assert.match(refresh, /gh run list[\s\S]*--workflow publish-kit-registry\.yml[\s\S]*--event workflow_dispatch/u);
  assert.match(refresh, /Publish Kit Registry \$REQUEST_ID/u);
  assert.match(refresh, /if \[\[ -z "\$run_id" \]\]; then[\s\S]*exit 1/u);
  assert.match(refresh, /gh run watch "\$run_id"[\s\S]*--exit-status/u);
  assert.doesNotMatch(refresh, /actions\/deploy-pages|pages:\s*write|id-token:\s*write/u);
});

test('publisher context validates product Tag identity with immutable v4 control-plane code', async () => {
  const workflow = await read('.github/workflows/publish-kit-reusable.yml');
  const context = jobBlock(workflow, 'context');
  assert.match(workflow, /^on:\n  workflow_call:\n    inputs:\n      release-tag:\n        description:\s*.+\n        required:\s*true\n        type:\s*string$/mu);
  assert.match(context, /runs-on:\s*ubuntu-latest/u);
  assert.match(context, /RELEASE_TAG:\s*\$\{\{ inputs\.release-tag \}\}/u);
  assert.match(context, /release-ref=refs\/tags\/\$RELEASE_TAG/u);
  assert.match(context, /actions\/checkout@v6[\s\S]*ref:\s*refs\/tags\/kit-publish-v4[\s\S]*path:\s*publisher/u);
  assert.match(context, /actions\/checkout@v6[\s\S]*ref:\s*\$\{\{ steps\.identity\.outputs\.release-ref \}\}[\s\S]*path:\s*source[\s\S]*fetch-depth:\s*0/u);
  assert.match(context, /git cat-file -t "\$RELEASE_REF"/u);
  assert.match(context, /git fetch --no-tags origin main/u);
  assert.match(context, /git merge-base --is-ancestor "\$release_commit" origin\/main/u);
  assert.match(context, /release-commit=\$release_commit/u);
  assert.ok(context.includes('^refs\\/tags\\/kit\\/'));
  assert.match(context, /loadTrustedMarketKit/u);
  assert.match(context, /repositoryRoot:\s*process\.env\.PRODUCT_SOURCE/u);
  assert.match(context, /policyFile:\s*process\.env\.PUBLISHER_POLICY/u);
  assert.match(context, /semver\.valid/u);
  assert.match(context, /RELEASE_REF:\s*\$\{\{ steps\.identity\.outputs\.release-ref \}\}/u);
  assert.match(context, /RELEASE_TAG:\s*\$\{\{ inputs\.release-tag \}\}/u);
  assert.match(context, /release-ref:\s*\$\{\{ steps\.identity\.outputs\.release-ref \}\}/u);
  assert.match(context, /release-commit:\s*\$\{\{ steps\.source\.outputs\.release-commit \}\}/u);
  for (const value of ['slug', 'version', 'channel', 'runner', 'kit-id', 'label', 'summary', 'tag']) {
    assert.match(context, new RegExp(`${value}:\\s*\\$\\{\\{ steps\\.policy\\.outputs\\.${value} \\}\\}`, 'u'));
  }
  assert.match(context, /GITHUB_OUTPUT/u);
  assert.match(context, /[\\u0000-\\u001f]/u);
  assert.doesNotMatch(context, /\bjq\b|fromJSON\(/u);
});

test('selected product Tag builds one checked artifact without executing its historical publisher', async () => {
  const workflow = await read('.github/workflows/publish-kit-reusable.yml');
  const prepare = jobBlock(workflow, 'prepare');
  assert.match(prepare, /needs:\s*context/u);
  assert.match(prepare, /runs-on:\s*\$\{\{ needs\.context\.outputs\.runner \}\}/u);
  assert.match(prepare, /actions\/checkout@v6[\s\S]*ref:\s*\$\{\{ needs\.context\.outputs\.release-ref \}\}[\s\S]*fetch-depth:\s*0/u);
  assert.match(prepare, /actions\/setup-node@v6[\s\S]*node-version:\s*22\.18\.0/u);
  assert.match(prepare, /npm install --global npm@10\.9\.3/u);
  assert.match(prepare, /run:\s*npm ci\s*$/mu);
  assert.match(
    prepare,
    /npm run kit:check -- "\$KIT_NAME" --output-directory "\$RUNNER_TEMP\/kit-check"/u,
  );
  assert.match(prepare, /npm run kits:boundary -- "\$KIT_NAME"/u);
  assert.match(
    prepare,
    /readdirSync\(directory, \{ withFileTypes: true \}\)[\s\S]*name\.endsWith\('\.hkit'\)[\s\S]*artifacts\.length !== 1/u,
  );
  assert.match(prepare, /appendFileSync\(process\.env\.GITHUB_OUTPUT, `kit-artifact=\$\{artifact\}\\n`/u);
  assert.doesNotMatch(prepare, /kit-publish\.mjs|--signer-workflow|release\.json/u);
  assert.match(prepare, /packages\/kit-cli\/dist\/cli\.js inspect/u);
  assert.match(prepare, /actions\/upload-artifact@v7[\s\S]*name:\s*kit-checked-artifact[\s\S]*retention-days:\s*1/u);
});

test('immutable v4 packages the checked artifact and leaves provenance to the GitHub execution', async () => {
  const workflow = await read('.github/workflows/publish-kit-reusable.yml');
  const packageJob = jobBlock(workflow, 'package');
  assert.match(packageJob, /needs:\s*\[context, prepare\]/u);
  assert.match(packageJob, /runs-on:\s*ubuntu-latest/u);
  assert.match(packageJob, /actions\/checkout@v6[\s\S]*ref:\s*refs\/tags\/kit-publish-v4/u);
  assert.match(packageJob, /actions\/download-artifact@v8[\s\S]*name:\s*kit-checked-artifact/u);
  assert.match(
    packageJob,
    /node scripts\/kit-publish\.mjs prepare[\s\S]*--kit-artifact "\$KIT_ARTIFACT"[\s\S]*--kit-id "\$KIT_ID"[\s\S]*--kit-version "\$EXPECTED_VERSION"[\s\S]*--kit-channel "\$EXPECTED_CHANNEL"/u,
  );
  assert.match(packageJob, /--commit "\$RELEASE_COMMIT"/u);
  assert.match(packageJob, /--workflow "\$GITHUB_REPOSITORY\/\.github\/workflows\/publish-kit\.yml@\$RELEASE_REF"/u);
  assert.match(packageJob, /--signer-workflow itharbors\/harbors\/\.github\/workflows\/publish-kit-reusable\.yml@refs\/tags\/kit-publish-v4/u);
  assert.match(packageJob, /--ref "\$RELEASE_REF"/u);
  assert.doesNotMatch(packageJob, /\$GITHUB_SHA|\$GITHUB_REF|\$GITHUB_WORKFLOW_REF|--kit-directory/u);
  assert.doesNotMatch(packageJob, /kit-publish\.mjs provenance|kit-provenance|predicate-path/u);
  assert.match(packageJob, /actions\/upload-artifact@v7[\s\S]*name:\s*kit-publication[\s\S]*retention-days:\s*1/u);
});

test('Preview and Stable Releases are non-clobbering, attested, and upload only the publication quartet', async () => {
  const workflow = await read('.github/workflows/publish-kit-reusable.yml');
  for (const [name, expected] of [
    ['publish-preview', /--prerelease/u],
    ['publish-stable', /environment:\s*\n\s+name:\s*kit-stable/u],
  ]) {
    const publish = jobBlock(workflow, name);
    assert.match(publish, /actions\/download-artifact@v8[\s\S]*name:\s*kit-publication/u);
    assert.doesNotMatch(publish, /kit-provenance|predicate-type|predicate-path/u);
    assert.match(publish, /gh api "repos\/\$GITHUB_REPOSITORY\/releases\/tags\/\$TAG"/u);
    assert.match(publish, /HTTP 404/u);
    assert.ok(publish.indexOf('Require missing') < publish.indexOf('actions/attest@v4'));
    assert.match(publish, /actions\/attest@v4[\s\S]*subject-path:[\s\S]*artifact-name[\s\S]*release\.json/u);
    assert.match(publish, /GH_REPO:\s*\$\{\{ github\.repository \}\}/u);
    assert.match(publish, /Release already exists:[\s\S]*exit 1[\s\S]*gh release create "\$TAG"/u);
    assert.match(publish, /--verify-tag/u);
    assert.match(publish, /RELEASE_COMMIT:\s*\$\{\{ needs\.context\.outputs\.release-commit \}\}/u);
    assert.match(publish, /--notes ".*\$RELEASE_COMMIT\."/u);
    assert.match(publish, expected);
    assert.doesNotMatch(publish, /--clobber|gh release upload/u);
    const releaseFiles = publish.match(/"\$RUNNER_TEMP\/kit-release\/[^"]+"/gu) ?? [];
    assert.deepEqual(releaseFiles, [
      '"$RUNNER_TEMP/kit-release/$ARTIFACT_NAME"',
      '"$RUNNER_TEMP/kit-release/release.json"',
      '"$RUNNER_TEMP/kit-release/sbom.spdx.json"',
      '"$RUNNER_TEMP/kit-release/registry-entry.json"',
    ]);
  }
  assert.match(jobBlock(workflow, 'publish-preview'), /--prerelease/u);
  for (const forbidden of [
    `HEAD:${legacyRegistryBranch}`,
    `--base ${legacyRegistryBranch}`,
    'registry-branch',
    'gh pr create',
    'gh release delete',
    'git push',
  ]) assert.equal(workflow.includes(forbidden), false);
});

test('publisher deploys Registry only after exactly one release job succeeds', async () => {
  const workflow = await read('.github/workflows/publish-kit-reusable.yml');
  const registry = jobBlock(workflow, 'publish-registry');
  const exactPredicate = "if: ${{ always() && ((needs.publish-preview.result == 'success' && needs.publish-stable.result == 'skipped') || (needs.publish-stable.result == 'success' && needs.publish-preview.result == 'skipped')) }}";
  assert.match(registry, /needs:\s*\[publish-preview, publish-stable\]/u);
  assert.ok(registry.includes(exactPredicate));
  for (const permission of ['contents: read', 'attestations: read', 'pages: write', 'id-token: write']) {
    assert.match(registry, new RegExp(permission, 'u'));
  }
  assert.match(
    registry,
    /uses:\s*itharbors\/harbors\/\.github\/workflows\/publish-kit-registry\.yml@kit-publish-v4/u,
  );
  assert.match(registry, /secrets:\s*inherit/u);
});

test('Registry workflow scans trusted Releases from main and deploys one validated Pages site', async () => {
  const workflow = await read('.github/workflows/publish-kit-registry.yml');
  assert.match(workflow, /^on:\n  workflow_call:\n  workflow_dispatch:\n    inputs:\n      request-id:\n        description:\s*.+\n        required:\s*true\n        type:\s*string$/mu);
  assert.match(workflow, /^run-name:\s*Publish Kit Registry \$\{\{ inputs\.request-id \}\}$/mu);
  assert.match(workflow, /group:\s*kit-registry-pages[\s\S]*cancel-in-progress:\s*false/u);
  const build = jobBlock(workflow, 'build');
  assert.match(build, /permissions:\n\s+contents:\s*read\n\s+attestations:\s*read/u);
  assert.match(build, /actions\/checkout@v6[\s\S]*ref:\s*main/u);
  assert.match(build, /actions\/setup-node@v6[\s\S]*node-version:\s*22\.18\.0/u);
  assert.match(build, /npm install --global npm@10\.9\.3/u);
  assert.match(build, /npm ci --ignore-scripts/u);
  assert.match(build, /npm run build -w @itharbors\/kit-core/u);
  assert.match(build, /npm run build -w @itharbors\/kit-cli/u);
  assert.match(build, /node scripts\/kit-publish\.mjs aggregate/u);
  for (const option of ['repository-root', 'repository', 'policy-file', 'revocations-file', 'generated-at']) {
    assert.match(build, new RegExp(`--${option}\\b`, 'u'));
  }
  assert.match(build, /--output "\$site_directory\/index\.v1\.json"/u);
  assert.match(build, /GITHUB_TOKEN:\s*\$\{\{ github\.token \}\}/u);
  assert.match(build, /actions\/configure-pages@v5/u);
  assert.match(build, /actions\/upload-pages-artifact@v4[\s\S]*path:\s*\$\{\{ runner\.temp \}\}\/registry-site/u);
  assert.doesNotMatch(build, /\bcp\b|\bmv\b|kit-registry/u);

  const deploy = jobBlock(workflow, 'deploy');
  assert.match(deploy, /needs:\s*build/u);
  assert.match(deploy, /pages:\s*write/u);
  assert.match(deploy, /id-token:\s*write/u);
  assert.match(deploy, /environment:[\s\S]*name:\s*github-pages/u);
  assert.match(deploy, /actions\/deploy-pages@v4/u);
  assert.match(workflow, /Release immutability[\s\S]*repository setting/u);
  assert.doesNotMatch(workflow, /gh api[\s\S]*(PATCH|PUT)|git (commit|push)/u);
  for (const forbidden of [
    `ref: ${legacyRegistryBranch}`,
    `HEAD:${legacyRegistryBranch}`,
    `--base ${legacyRegistryBranch}`,
  ]) assert.equal(workflow.includes(forbidden), false);
});

test('obsolete product and Registry branch templates are removed', async () => {
  for (const relative of [
    '.github/kit-templates/publish-kit.yml',
    '.github/kit-templates/registry-pages.yml',
  ]) {
    await assert.rejects(access(new URL(relative, root)));
  }
});
