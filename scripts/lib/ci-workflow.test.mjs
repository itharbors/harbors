import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const rootUrl = new URL('../../', import.meta.url);
const workflowUrl = new URL('.github/workflows/ci.yaml', rootUrl);
const kitWorkflowUrl = new URL('.github/workflows/kit-ci.yml', rootUrl);
const packageUrl = new URL('package.json', rootUrl);
const packageLockUrl = new URL('package-lock.json', rootUrl);

test('CI installs locked dependencies before running the repository check', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const installIndex = workflow.indexOf('run: npm ci');
  const checkIndex = workflow.indexOf('run: npm run check');

  assert.notEqual(installIndex, -1, 'CI must install dependencies with npm ci');
  assert.notEqual(checkIndex, -1, 'CI must run the repository check script');
  assert.ok(installIndex < checkIndex, 'CI must install dependencies before checking');
});

test('CI only invokes npm scripts declared by the root package', async () => {
  const [workflow, packageText] = await Promise.all([
    readFile(workflowUrl, 'utf8'),
    readFile(packageUrl, 'utf8'),
  ]);
  const packageJson = JSON.parse(packageText);
  const invokedScripts = [...workflow.matchAll(/run:\s+npm run ([\w:-]+)/g)].map(
    ([, script]) => script,
  );

  assert.ok(invokedScripts.length > 0, 'CI must invoke at least one npm script');
  for (const script of invokedScripts) {
    assert.ok(
      Object.hasOwn(packageJson.scripts ?? {}, script),
      `CI invokes missing root npm script: ${script}`,
    );
  }
});

test('CI dependency lock does not reference the private npm registry', async () => {
  const packageLock = await readFile(packageLockUrl, 'utf8');

  assert.equal(
    packageLock.includes('https://bnpm.byted.org/'),
    false,
    'package-lock.json must use a registry reachable by public GitHub runners',
  );
});

test('CI runs for every pull request change without repository-inaccurate path filters', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const triggers = parseWorkflowTriggers(workflow);

  assert.ok(triggers.has('pull_request'), 'CI must declare a pull_request trigger');
  assert.equal(
    triggers.get('pull_request').has('paths'),
    false,
    'pull_request CI must not skip changes outside an incomplete path allowlist',
  );
});

test('Kit CI selects event-specific full-history Git comparisons without path trigger gaps', async () => {
  const workflow = await readFile(kitWorkflowUrl, 'utf8');
  const triggers = parseWorkflowTriggers(workflow);

  for (const trigger of ['pull_request', 'merge_group', 'push']) {
    assert.ok(triggers.has(trigger), `Kit CI must declare a ${trigger} trigger`);
    assert.equal(triggers.get(trigger).has('paths'), false, `${trigger} must not use paths filters`);
  }
  assert.match(workflow, /push:\s*\n\s+branches:\s*\n\s+- main/u);
  assert.match(workflow, /actions\/checkout@v6[\s\S]*fetch-depth:\s*0/u);
  assert.match(workflow, /github\.event\.pull_request\.base\.sha/u);
  assert.match(workflow, /github\.event\.merge_group\.base_sha/u);
  assert.match(workflow, /github\.event\.before/u);
  assert.match(workflow, /0\{40\}/u);
  assert.match(workflow, /git rev-list --max-parents=0 --max-count=1/u);
  assert.match(workflow, /node scripts\/select-kit-ci\.mjs/u);
});

test('Kit CI builds Kit Core before loading the selector in a clean checkout', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'kit-ci-clean-'));
  try {
    await Promise.all([
      mkdir(path.join(fixture, 'scripts/lib'), { recursive: true }),
      mkdir(path.join(fixture, 'packages/kit-core'), { recursive: true }),
      mkdir(path.join(fixture, 'node_modules/@itharbors'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        path.join(fixture, 'scripts/lib/kit-monorepo.mjs'),
        await readFile(new URL('scripts/lib/kit-monorepo.mjs', rootUrl)),
      ),
      writeFile(
        path.join(fixture, 'scripts/lib/repository-kits.mjs'),
        await readFile(new URL('scripts/lib/repository-kits.mjs', rootUrl)),
      ),
      writeFile(
        path.join(fixture, 'packages/kit-core/package.json'),
        await readFile(new URL('packages/kit-core/package.json', rootUrl)),
      ),
    ]);
    await symlink(
      path.join(fixture, 'packages/kit-core'),
      path.join(fixture, 'node_modules/@itharbors/kit-core'),
      'dir',
    );
    const cleanLoad = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      "await import('./scripts/lib/kit-monorepo.mjs')",
    ], { cwd: fixture, encoding: 'utf8' });
    assert.equal(cleanLoad.status, 1);
    assert.match(cleanLoad.stderr, /ERR_MODULE_NOT_FOUND[\s\S]*kit-core\/dist\/index\.js/u);

    const select = workflowJob(await readFile(kitWorkflowUrl, 'utf8'), 'select');
    const installIndex = select.indexOf('run: npm ci');
    const buildIndex = select.indexOf('run: npm run build -w @itharbors/kit-core');
    const selectorIndex = select.indexOf('node scripts/select-kit-ci.mjs');
    assert.notEqual(installIndex, -1);
    assert.notEqual(buildIndex, -1);
    assert.notEqual(selectorIndex, -1);
    assert.ok(installIndex < buildIndex && buildIndex < selectorIndex);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('Kit CI exposes safe selector outputs and skips the matrix when no Kit applies', async () => {
  const workflow = await readFile(kitWorkflowUrl, 'utf8');
  const select = workflowJob(workflow, 'select');
  const checkKit = workflowJob(workflow, 'check-kit');

  assert.match(select, /id:\s*selection/u);
  assert.match(select, /GITHUB_OUTPUT/u);
  assert.match(select, /matrix-json/u);
  assert.match(select, /has-kits/u);
  assert.match(select, /MATRIX_JSON/u);
  assert.match(select, /HAS_KITS/u);
  assert.match(select, /matrix-json:\s*\$\{\{ steps\.selection\.outputs\.matrix-json \}\}/u);
  assert.match(select, /has-kits:\s*\$\{\{ steps\.selection\.outputs\.has-kits \}\}/u);
  assert.match(checkKit, /if:\s*needs\.select\.outputs\.has-kits == 'true'/u);
  assert.match(checkKit, /include:\s*\$\{\{ fromJSON\(needs\.select\.outputs\.matrix-json\)\.include \}\}/u);
});

test('Kit CI runs each descriptor-owned matrix entry after installing lifecycle dependencies and never publishes', async () => {
  const workflow = await readFile(kitWorkflowUrl, 'utf8');
  const checkKit = workflowJob(workflow, 'check-kit');
  const installIndex = checkKit.indexOf('run: npm ci');
  const lifecycleBuildIndex = checkKit.indexOf('npm run build -w @itharbors/kit-core -w @itharbors/kit-cli');
  const checkIndex = checkKit.indexOf('node scripts/run-kit-matrix.mjs check "${{ matrix.kit }}"');

  assert.match(checkKit, /needs:\s*select/u);
  assert.match(checkKit, /runs-on:\s*\$\{\{ matrix\.runner \}\}/u);
  assert.match(checkKit, /fail-fast:\s*false/u);
  assert.notEqual(installIndex, -1);
  assert.notEqual(checkIndex, -1);
  assert.notEqual(lifecycleBuildIndex, -1);
  assert.ok(installIndex < lifecycleBuildIndex && lifecycleBuildIndex < checkIndex);
  assert.doesNotMatch(checkKit, /output_directory|kit:check/u);
  assert.match(checkKit, /node scripts\/run-kit-matrix\.mjs check "\$\{\{ matrix\.kit \}\}"/u);
  assert.doesNotMatch(workflow, /publish-kit|kit-publish|gh release|actions\/attest/u);
});

test('root test delegates Kit work to descriptor-driven lifecycle scripts', async () => {
  const packageJson = JSON.parse(await readFile(packageUrl, 'utf8'));
  assert.equal(
    packageJson.scripts['test:kit-ci-selection'],
    'node --test scripts/lib/kit-ci-selection.test.mjs',
  );
  assert.equal(packageJson.scripts['kits:build'], 'node scripts/run-kit-matrix.mjs build');
  assert.equal(packageJson.scripts['kits:test'], 'node scripts/run-kit-matrix.mjs test');
  assert.equal(packageJson.scripts['kits:check'], 'node scripts/run-kit-matrix.mjs check');
  assert.equal(packageJson.scripts.test, 'npm run test:framework && npm run kits:test && npm run test:workflows');
  assert.match(packageJson.scripts['test:workflows'], /npm run test:kit-ci-selection/u);
  const scriptText = JSON.stringify(packageJson.scripts);
  assert.doesNotMatch(scriptText, /@itharbors\/kit-(?:agent-guard|csv|mysql|notifications|scheduler|skill-manager|sqlite|traceweave)/u);
  assert.equal(Object.hasOwn(packageJson.scripts, 'test:agent-guard'), false);
});

test('root test registers live Kit deactivation coverage', async () => {
  const packageJson = JSON.parse(await readFile(packageUrl, 'utf8'));
  assert.match(packageJson.scripts['test:framework'], /scripts\/lib\/kit-live-deactivation\.test\.mjs/u);
});

test('root Framework test command references only existing test files', async () => {
  const packageJson = JSON.parse(await readFile(packageUrl, 'utf8'));
  const testFiles = packageJson.scripts['test:framework'].match(/scripts\/[^ ]+\.test\.mjs/gu) ?? [];
  assert.ok(testFiles.length > 0);
  assert.equal(testFiles.includes('scripts/lib/codex-skill-resource.test.mjs'), false);
  await Promise.all(testFiles.map((file) => access(new URL(file, rootUrl))));
});

function workflowJob(workflow, name) {
  const marker = `\n  ${name}:\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `workflow must contain ${name} job`);
  const remainder = workflow.slice(start + marker.length);
  const next = remainder.search(/^  [a-z][a-z0-9-]*:\n/mu);
  return next === -1 ? remainder : remainder.slice(0, next);
}

function parseWorkflowTriggers(workflow) {
  const lines = workflow.split(/\r?\n/);
  const onIndex = lines.findIndex((line) => line === 'on:');
  assert.notEqual(onIndex, -1, 'workflow must contain a top-level on mapping');
  const triggers = new Map();
  let currentTrigger = null;
  for (const line of lines.slice(onIndex + 1)) {
    if (/^\S/.test(line)) break;
    const trigger = line.match(/^  ([\w-]+):/);
    if (trigger) {
      currentTrigger = trigger[1];
      triggers.set(currentTrigger, new Set());
      continue;
    }
    const property = line.match(/^    ([\w-]+):/);
    if (property && currentTrigger) triggers.get(currentTrigger).add(property[1]);
  }
  return triggers;
}
