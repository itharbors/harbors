import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const rootUrl = new URL('../../', import.meta.url);
const workflowUrl = new URL('.github/workflows/ci.yaml', rootUrl);
const kitWorkflowUrl = new URL('.github/workflows/kit-ci.yml', rootUrl);
const packageUrl = new URL('package.json', rootUrl);
const packageLockUrl = new URL('package-lock.json', rootUrl);

test('root package exposes Framework boundary, test, and plugin-check scripts', async () => {
  const packageJson = JSON.parse(await readFile(packageUrl, 'utf8'));
  const scripts = packageJson.scripts ?? {};
  assert.equal(typeof scripts['kits:boundary'], 'string');
  assert.equal(typeof scripts['test:framework'], 'string');
  assert.equal(typeof scripts['plugins:check:framework'], 'string');
  assert.equal(typeof scripts.check, 'string');
});

test('root test and check scripts reference only declared root npm scripts', async () => {
  const packageJson = JSON.parse(await readFile(packageUrl, 'utf8'));
  const scripts = packageJson.scripts ?? {};
  const referenced = [...(scripts.test ?? '').matchAll(/npm run ([\w:-]+)/g)].map(([, s]) => s);
  for (const script of referenced) {
    assert.ok(Object.hasOwn(scripts, script), `test script references missing root script: ${script}`);
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

test('every Kit dependency lock uses a registry reachable by public CI', async () => {
  const kitEntries = await readdir(new URL('kits/', rootUrl), { withFileTypes: true });
  const kitLocks = await Promise.all(kitEntries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => ({
      kit: entry.name,
      lock: await readFile(new URL(`kits/${entry.name}/package-lock.json`, rootUrl), 'utf8'),
    })));

  for (const { kit, lock } of kitLocks) {
    assert.equal(
      lock.includes('https://bnpm.byted.org/'),
      false,
      `${kit}/package-lock.json must use a registry reachable by public CI`,
    );
  }
});

test('CI locks the Linux x64 Rollup binary required by Ubuntu', async () => {
  const [packageText, packageLockText] = await Promise.all([
    readFile(packageUrl, 'utf8'),
    readFile(packageLockUrl, 'utf8'),
  ]);
  const packageJson = JSON.parse(packageText);
  const packageLock = JSON.parse(packageLockText);
  const version = '4.60.4';
  const packageName = '@rollup/rollup-linux-x64-gnu';
  const lockedPackage = packageLock.packages?.[`node_modules/${packageName}`];

  assert.equal(packageJson.optionalDependencies?.[packageName], version);
  assert.equal(packageLock.packages?.['']?.optionalDependencies?.[packageName], version);
  assert.equal(lockedPackage?.version, version);
  assert.equal(
    lockedPackage?.resolved,
    `https://registry.npmjs.org/${packageName}/-/${packageName.split('/')[1]}-${version}.tgz`,
  );
  assert.match(lockedPackage?.integrity ?? '', /^sha512-/u);
  assert.deepEqual(lockedPackage?.os, ['linux']);
  assert.deepEqual(lockedPackage?.cpu, ['x64']);
  assert.equal(lockedPackage?.optional, true);

});

test('CI locks the Linux x64 esbuild binary required by script-isolated Framework builds', async () => {
  const [packageText, packageLockText] = await Promise.all([
    readFile(packageUrl, 'utf8'),
    readFile(packageLockUrl, 'utf8'),
  ]);
  const packageJson = JSON.parse(packageText);
  const packageLock = JSON.parse(packageLockText);
  const version = '0.28.0';
  const packageName = '@esbuild/linux-x64';
  const lockedPackage = packageLock.packages?.[`node_modules/${packageName}`];

  assert.equal(packageJson.optionalDependencies?.[packageName], version);
  assert.equal(packageLock.packages?.['']?.optionalDependencies?.[packageName], version);
  assert.equal(lockedPackage?.version, version);
  assert.equal(
    lockedPackage?.resolved,
    `https://registry.npmjs.org/${packageName}/-/${packageName.split('/')[1]}-${version}.tgz`,
  );
  assert.match(lockedPackage?.integrity ?? '', /^sha512-/u);
  assert.deepEqual(lockedPackage?.os, ['linux']);
  assert.deepEqual(lockedPackage?.cpu, ['x64']);
  assert.equal(lockedPackage?.optional, true);

  for (const [packagePath, nestedVersion] of [
    ['node_modules/vite/node_modules/@esbuild/linux-x64', '0.21.5'],
    ['packages/client/node_modules/@esbuild/linux-x64', '0.25.12'],
  ]) {
    const nestedPackage = packageLock.packages?.[packagePath];
    assert.equal(nestedPackage?.version, nestedVersion, packagePath);
    assert.equal(
      nestedPackage?.resolved,
      `https://registry.npmjs.org/${packageName}/-/${packageName.split('/')[1]}-${nestedVersion}.tgz`,
      packagePath,
    );
    assert.match(nestedPackage?.integrity ?? '', /^sha512-/u, packagePath);
    assert.deepEqual(nestedPackage?.os, ['linux'], packagePath);
    assert.deepEqual(nestedPackage?.cpu, ['x64'], packagePath);
    assert.equal(nestedPackage?.optional, true, packagePath);
  }
});

test('root workflows test script exercises Kit CI selection and check suites', async () => {
  const packageJson = JSON.parse(await readFile(packageUrl, 'utf8'));
  const scripts = packageJson.scripts ?? {};
  assert.match(scripts['test:workflows'] ?? '', /test:kit-ci-selection/u);
  assert.match(scripts['test:workflows'] ?? '', /test:kit-check/u);
});

test('root check and preflight scripts run boundary, framework, workflow, Kit, and plugin checks', async () => {
  const packageJson = JSON.parse(await readFile(packageUrl, 'utf8'));
  const scripts = packageJson.scripts ?? {};
  assert.match(scripts['check:preflight'] ?? '', /kits:boundary/u);
  assert.match(scripts.check ?? '', /test:framework:prepared/u);
  assert.match(scripts.check ?? '', /test:workflows/u);
  assert.match(scripts.check ?? '', /kits:check/u);
  assert.match(scripts.check ?? '', /plugins:check:framework/u);
});

test('Kit CI selector uses full-history Git diff and canonical Kit paths', async () => {
  const selector = await readFile(new URL('scripts/select-kit-ci.mjs', rootUrl), 'utf8');
  assert.match(selector, /rev-list.*--max-count=1/u);
  assert.match(selector, /'diff'/u);
  assert.match(selector, /'--no-renames'/u);
  assert.match(selector, /selectKitSlugs/u);
  assert.match(selector, /discoverRepositoryKits/u);
  assert.doesNotMatch(selector, /plan-kit-releases|kit-publish/u);
});

test('root package retains the local Kit boundary check without publication commands', async () => {
  const packageJson = JSON.parse(await readFile(packageUrl, 'utf8'));
  assert.equal(typeof packageJson.scripts['kit:boundary'], 'string');
  assert.doesNotMatch(JSON.stringify(packageJson.scripts), /plan-kit-releases|kit-publish/u);
});

test('Kit CI selector requires Kit Core to be built before loading kit-monorepo', async () => {
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
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('Kit CI selector emits MATRIX_JSON and HAS_KITS outputs for downstream matrix jobs', async () => {
  const selector = await readFile(new URL('scripts/select-kit-ci.mjs', rootUrl), 'utf8');
  assert.match(selector, /MATRIX_JSON/u);
  assert.match(selector, /HAS_KITS/u);
  assert.match(selector, /ciRunner/u);
});

test('Kit CI selector does not invoke release planning or publish scripts', async () => {
  const selector = await readFile(new URL('scripts/select-kit-ci.mjs', rootUrl), 'utf8');
  assert.doesNotMatch(selector, /plan-kit-releases|RELEASES_JSON|kit-publish/u);
});

test('Kit lifecycle matrix runs boundary then check without publish or release steps', async () => {
  const matrix = await readFile(new URL('scripts/run-kit-matrix.mjs', rootUrl), 'utf8');
  assert.match(matrix, /build/u);
  assert.match(matrix, /test/u);
  assert.match(matrix, /validate/u);
  assert.match(matrix, /check/u);
  assert.doesNotMatch(matrix, /publish|release|plan-kit-releases/u);

  const packageJson = JSON.parse(await readFile(packageUrl, 'utf8'));
  assert.equal(packageJson.scripts['kits:check'], 'node scripts/run-kit-matrix.mjs check');
  assert.doesNotMatch(JSON.stringify(packageJson.scripts), /publish-kit|kit-publish|release-kit/u);
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
  assert.equal(packageJson.scripts['kits:boundary'], 'node scripts/check-kit-architecture.mjs');
  assert.equal(packageJson.scripts['plugins:check:framework'], 'node scripts/ce-plugin.mjs check --framework');
  assert.equal(packageJson.scripts['plugins:check'], 'npm run plugins:check:framework && npm run kits:build');
  assert.equal(packageJson.scripts.test, 'npm run test:framework && npm run kits:test && npm run test:workflows');
  assert.equal(
    packageJson.scripts['test:framework'],
    'npm run test:toolchain && npm run test -w @itharbors/magnet && npm run test:framework:prepared',
  );
  assert.match(
    packageJson.scripts['test:framework:prepared'],
    /npm run test -w packages\/server/u,
  );
  assert.match(packageJson.scripts['test:preflight'], /--test-reporter=dot/u);
  assert.equal(
    packageJson.scripts['check:preflight'],
    'npm run kits:boundary && npm run test:preflight',
  );
  assert.equal(
    packageJson.scripts.check,
    'npm run build && npm run test:framework:prepared && npm run test:workflows && npm run kits:check && npm run plugins:check:framework',
  );
  assert.match(packageJson.scripts['test:workflows'], /npm run test:kit-ci-selection/u);
  const scriptText = JSON.stringify(packageJson.scripts);
  assert.doesNotMatch(scriptText, /@itharbors\/kit-(?:agent-guard|csv|mysql|notifications|scheduler|skill-manager|sqlite|traceweave)/u);
  assert.equal(Object.hasOwn(packageJson.scripts, 'test:default'), false);
});

test('root test retains the prepared Framework suite', async () => {
  const packageJson = JSON.parse(await readFile(packageUrl, 'utf8'));
  assert.ok(packageJson.scripts['test:framework:prepared']);
});

test('prepared Framework test command references only existing test files', async () => {
  const packageJson = JSON.parse(await readFile(packageUrl, 'utf8'));
  const testFiles = packageJson.scripts['test:framework:prepared']?.match(
    /scripts\/[^ ]+\.test\.mjs/gu,
  ) ?? [];
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
