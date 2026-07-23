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

test('mainline caller publishes only exact Kit version Tags through immutable v2 workflows', async () => {
  const workflow = await read('.github/workflows/publish-kit.yml');
  assert.match(workflow, /^on:\n  push:\n    tags:\n      - ['"]kit\/\*\/v\*['"]$/mu);
  assert.doesNotMatch(workflow, /branches:|workflow_dispatch:|pull_request:|\bmain\b/u);
  assert.match(
    workflow,
    /uses:\s*itharbors\/harbors\/\.github\/workflows\/publish-kit-reusable\.yml@kit-publish-v2/u,
  );
  assert.match(workflow, /secrets:\s*inherit/u);
  for (const permission of ['contents: write', 'id-token: write', 'attestations: write', 'pages: write']) {
    assert.match(workflow, new RegExp(permission, 'u'));
  }
});

test('publisher context validates exact Tag identity and trusted mainline policy without injectable outputs', async () => {
  const workflow = await read('.github/workflows/publish-kit-reusable.yml');
  const context = jobBlock(workflow, 'context');
  assert.match(workflow, /^on:\n  workflow_call:$/mu);
  assert.match(context, /runs-on:\s*ubuntu-latest/u);
  assert.match(context, /actions\/checkout@v6[\s\S]*ref:\s*\$\{\{ github\.ref \}\}[\s\S]*fetch-depth:\s*0/u);
  assert.match(context, /git fetch --no-tags origin main/u);
  assert.match(context, /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/u);
  assert.ok(context.includes('^refs\\/tags\\/kit\\/'));
  assert.match(context, /loadOfficialKit/u);
  assert.match(context, /semver\.valid/u);
  for (const value of ['slug', 'version', 'channel', 'runner', 'kit-id', 'label', 'summary', 'tag']) {
    assert.match(context, new RegExp(`${value}:\\s*\\$\\{\\{ steps\\.policy\\.outputs\\.${value} \\}\\}`, 'u'));
  }
  assert.match(context, /GITHUB_OUTPUT/u);
  assert.match(context, /[\\u0000-\\u001f]/u);
  assert.doesNotMatch(context, /\bjq\b|fromJSON\(/u);
});

test('prepare uses the selected runner and one pinned check-prepare-inspect pipeline', async () => {
  const workflow = await read('.github/workflows/publish-kit-reusable.yml');
  const prepare = jobBlock(workflow, 'prepare');
  assert.match(prepare, /needs:\s*context/u);
  assert.match(prepare, /runs-on:\s*\$\{\{ needs\.context\.outputs\.runner \}\}/u);
  assert.match(prepare, /actions\/checkout@v6[\s\S]*ref:\s*\$\{\{ github\.ref \}\}/u);
  assert.match(prepare, /actions\/setup-node@v6[\s\S]*node-version:\s*22\.18\.0/u);
  assert.match(prepare, /npm install --global npm@10\.9\.3/u);
  assert.match(prepare, /run:\s*npm ci\s*$/mu);
  assert.match(
    prepare,
    /npm run kit:check -- "\$KIT_NAME" --output-directory "\$RUNNER_TEMP\/kit-check"/u,
  );
  assert.match(
    prepare,
    /node scripts\/kit-publish\.mjs prepare[\s\S]*--kit-directory "kits\/\$KIT_NAME"/u,
  );
  assert.match(prepare, /packages\/kit-cli\/dist\/cli\.js inspect/u);
  assert.match(prepare, /Tag, Kit manifest, package, and artifact versions must match/u);
  assert.match(prepare, /actions\/upload-artifact@v7[\s\S]*name:\s*kit-publication[\s\S]*retention-days:\s*1/u);
});

test('Preview and Stable Releases are non-clobbering, attested, and upload only the publication quartet', async () => {
  const workflow = await read('.github/workflows/publish-kit-reusable.yml');
  for (const [name, expected] of [
    ['publish-preview', /--prerelease/u],
    ['publish-stable', /environment:\s*\n\s+name:\s*kit-stable/u],
  ]) {
    const publish = jobBlock(workflow, name);
    assert.match(publish, /actions\/download-artifact@v8/u);
    assert.match(publish, /actions\/attest@v4[\s\S]*artifact-name[\s\S]*release\.json/u);
    assert.match(publish, /GH_REPO:\s*\$\{\{ github\.repository \}\}/u);
    assert.match(publish, /gh release view "\$TAG"[\s\S]*already exists[\s\S]*exit 1[\s\S]*gh release create "\$TAG"/u);
    assert.match(publish, /--verify-tag/u);
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
  assert.match(registry, /needs:\s*\[publish-preview, publish-stable\]/u);
  assert.match(
    registry,
    /if:\s*\$\{\{ always\(\) && \(needs\.publish-preview\.result == 'success' \|\| needs\.publish-stable\.result == 'success'\) \}\}/u,
  );
  assert.match(
    registry,
    /uses:\s*itharbors\/harbors\/\.github\/workflows\/publish-kit-registry\.yml@kit-publish-v2/u,
  );
  assert.match(registry, /secrets:\s*inherit/u);
});

test('Registry workflow scans trusted Releases from main and deploys only one Pages index', async () => {
  const workflow = await read('.github/workflows/publish-kit-registry.yml');
  assert.match(workflow, /^on:\n  workflow_call:\n  workflow_dispatch:$/mu);
  assert.match(workflow, /group:\s*kit-registry-pages[\s\S]*cancel-in-progress:\s*false/u);
  const build = jobBlock(workflow, 'build');
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
