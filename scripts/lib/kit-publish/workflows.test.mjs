import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../../', import.meta.url);

async function read(relative) {
  return readFile(new URL(relative, root), 'utf8');
}

test('Kit caller template only publishes its product branch and immutable Stable tags', async () => {
  const workflow = await read('.github/kit-templates/publish-kit.yml');
  assert.match(workflow, /branches:\s*\n\s*- kit\/__KIT_NAME__/u);
  assert.match(workflow, /tags:\s*\n\s*- ['"]kit\/__KIT_NAME__\/v\*['"]/u);
  assert.match(
    workflow,
    /uses:\s*itharbors\/harbors\/\.github\/workflows\/publish-kit-reusable\.yml@kit-publish-v1/u,
  );
  for (const permission of ['contents: write', 'id-token: write', 'attestations: write', 'pull-requests: write']) {
    assert.match(workflow, new RegExp(permission, 'u'));
  }
  assert.doesNotMatch(workflow, /workflow_dispatch|pull_request|main/u);
});

test('reusable publisher builds with a pinned toolchain before attesting and creating Releases', async () => {
  const workflow = await read('.github/workflows/publish-kit-reusable.yml');
  assert.match(workflow, /workflow_call:/u);
  assert.match(workflow, /runner:[\s\S]*default:\s*ubuntu-latest/u);
  assert.match(workflow, /runs-on:\s*\$\{\{ inputs\.runner \}\}/u);
  assert.match(workflow, /repository:\s*itharbors\/harbors/u);
  assert.match(workflow, /ref:\s*kit-publish-v1/u);
  assert.match(workflow, /actions\/checkout@v6/u);
  assert.match(workflow, /actions\/setup-node@v6/u);
  assert.match(workflow, /actions\/upload-artifact@v7/u);
  assert.match(workflow, /actions\/download-artifact@v8/u);
  assert.match(workflow, /actions\/attest@v4/u);
  assert.match(workflow, /npm ci --ignore-scripts/u);
  assert.match(workflow, /npm ci\s*\n/u);
  assert.match(workflow, /npm test/u);
  assert.match(workflow, /npm run build/u);
  assert.match(workflow, /kit-publish\.mjs prepare/u);
  assert.match(
    workflow,
    /--signer-workflow\s+itharbors\/harbors\/\.github\/workflows\/publish-kit-reusable\.yml@refs\/tags\/kit-publish-v1/u,
  );
  assert.match(workflow, /inspect/u);
  assert.match(workflow, /subject-path:[\s\S]*artifact-name[\s\S]*release\.json/u);
});

test('Stable publication is protected, immutable, and opens a Registry review PR', async () => {
  const workflow = await read('.github/workflows/publish-kit-reusable.yml');
  assert.match(workflow, /publish-stable:[\s\S]*environment:\s*\n\s*name:\s*kit-stable/u);
  assert.match(workflow, /gh release view/u);
  assert.match(workflow, /Stable Release already exists/u);
  assert.match(workflow, /gh release create/u);
  assert.match(workflow, /--verify-tag/u);
  assert.doesNotMatch(workflow, /--clobber/u);
  assert.match(workflow, /gh pr create[\s\S]*--base kit-registry/u);
  assert.match(workflow, /pull-requests:\s*write/u);
});

test('Preview publication is a prerelease, updates only preview metadata, and retains ten releases', async () => {
  const workflow = await read('.github/workflows/publish-kit-reusable.yml');
  assert.match(workflow, /publish-preview:/u);
  assert.match(workflow, /--prerelease/u);
  assert.match(workflow, /preview\.json/u);
  assert.match(workflow, /HEAD:kit-registry/u);
  assert.match(workflow, /tail -n \+11/u);
  assert.match(workflow, /startswith\(\$prefix\)/u);
  assert.match(workflow, /gh release delete[\s\S]*--cleanup-tag/u);
});

test('Registry branch template verifies every Release and deploys only validated Pages output', async () => {
  const workflow = await read('.github/kit-templates/registry-pages.yml');
  assert.match(workflow, /branches:\s*\n\s*- kit-registry/u);
  assert.match(workflow, /pull_request:[\s\S]*branches:\s*\n\s*- kit-registry/u);
  assert.match(workflow, /ref:\s*kit-publish-v1/u);
  assert.match(workflow, /kit-publish\.mjs aggregate/u);
  assert.match(workflow, /actions\/upload-pages-artifact@v4/u);
  assert.match(workflow, /actions\/deploy-pages@v4/u);
  assert.match(workflow, /github\.event_name == 'push'/u);
  assert.match(workflow, /pages:\s*write/u);
  assert.match(workflow, /id-token:\s*write/u);
});
