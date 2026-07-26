import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const rootUrl = new URL('../../../', import.meta.url);
const workflowUrl = new URL('.github/workflows/build-unsigned-app.yml', rootUrl);

test('unsigned app build is manual, main-only, read-only, and isolated from releases', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

  assert.match(workflow, /^on:\s*\n\s+workflow_dispatch:\s*$/mu);
  assert.doesNotMatch(workflow, /\b(push|pull_request|schedule):/u);
  assert.match(workflow, /^permissions:\s*\n\s+contents:\s*read\s*$/mu);
  assert.doesNotMatch(workflow, /contents:\s*write|id-token:\s*write|attestations:\s*write|packages:\s*write|deployments:\s*write/u);
  assert.match(workflow, /EXPECTED_REF:\s*refs\/heads\/main/u);
  assert.match(workflow, /"\$GITHUB_REF" == "\$EXPECTED_REF"/u);
  assert.match(workflow, /ref:\s*\$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /git rev-parse HEAD[\s\S]*GITHUB_SHA/u);
  assert.doesNotMatch(workflow, /^\s+environment:|secrets\.|GH_TOKEN|github\.token|gh release|git tag|actions\/attest/mu);
});

test('unsigned app build pins arm64 tooling and runs checks before the explicit build', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const actions = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gmu)]
    .map((match) => match[1]);

  assert.deepEqual(actions, [
    'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803',
    'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38',
    'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
  ]);
  assert.match(workflow, /runs-on:\s*macos-15/u);
  assert.match(workflow, /uname -m[\s\S]*arm64/u);
  assert.match(workflow, /node-version:\s*22\.18\.0/u);
  assert.match(workflow, /npm install --global npm@10\.9\.3/u);
  const installIndex = workflow.indexOf('run: npm ci');
  const checkIndex = workflow.indexOf('run: npm run check');
  const buildIndex = workflow.indexOf('run: npm run desktop:unsigned');
  assert.ok(installIndex !== -1 && checkIndex > installIndex && buildIndex > checkIndex);
  assert.doesNotMatch(workflow, /npm run desktop:dist|--publish/u);
});

test('unsigned app build verifies startup and uploads the exact short-lived warning bundle', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

  assert.match(workflow, /codesign -dv --verbose=4[\s\S]*Authority=Developer ID Application:/u);
  assert.match(workflow, /file "\$EXECUTABLE"[\s\S]*arm64/u);
  assert.match(workflow, /mktemp -d[\s\S]*HARBORS_DISABLE_UPDATE_CHECKS=1[\s\S]*--user-data-dir[\s\S]*\/api\/health/u);
  assert.doesNotMatch(workflow, /--disable-background-networking/u);
  assert.match(workflow, /ITHARBORS-\$DESKTOP_VERSION-unsigned-arm64\.dmg/u);
  assert.match(workflow, /ITHARBORS-\$DESKTOP_VERSION-unsigned-arm64-mac\.zip/u);
  assert.match(workflow, /UNSIGNED-BUILD\.txt/u);
  assert.match(workflow, /checksums\.txt/u);
  assert.match(workflow, /shasum -a 256/u);
  assert.match(workflow, /\$\{#STAGED_FILES\[@\]\}.*-ne 4/u);
  assert.match(workflow, /name:\s*ITHARBORS-\$\{\{ steps\.metadata\.outputs\.version \}\}-unsigned-\$\{\{ github\.run_id \}\}/u);
  assert.match(workflow, /retention-days:\s*7/u);
  assert.match(workflow, /if-no-files-found:\s*error/u);
  assert.doesNotMatch(workflow, /latest-mac\.yml|\.blockmap|sbom|provenance|attestation/u);
});
