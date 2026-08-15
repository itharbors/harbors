import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';

const rootUrl = new URL('../../', import.meta.url);
const packageUrl = new URL('package.json', rootUrl);
const pnpmLockUrl = new URL('pnpm-lock.yaml', rootUrl);

test('root package exposes Framework boundary, test, and plugin-check scripts', async () => {
  const packageJson = JSON.parse(await readFile(packageUrl, 'utf8'));
  const scripts = packageJson.scripts ?? {};
  assert.equal(typeof scripts['kits:boundary'], 'string');
  assert.equal(typeof scripts['test:framework'], 'string');
  assert.equal(typeof scripts['plugins:check:framework'], 'string');
  assert.equal(typeof scripts.check, 'string');
});

test('root test and check scripts reference only declared root pnpm scripts', async () => {
  const packageJson = JSON.parse(await readFile(packageUrl, 'utf8'));
  const scripts = packageJson.scripts ?? {};
  const referenced = [...(scripts.test ?? '').matchAll(/pnpm run ([\w:-]+)/g)].map(([, s]) => s);
  for (const script of referenced) {
    assert.ok(Object.hasOwn(scripts, script), `test script references missing root script: ${script}`);
  }
});

test('pnpm dependency lock does not reference the private npm registry', async () => {
  const lockfile = await readFile(pnpmLockUrl, 'utf8');

  assert.equal(
    lockfile.includes('https://bnpm.byted.org/'),
    false,
    'pnpm-lock.yaml must use a registry reachable by public GitHub runners',
  );
});

test('every Kit dependency lock uses a registry reachable by public CI', async () => {
  const kitEntries = await readdir(new URL('kits/', rootUrl), { withFileTypes: true });
  const kitLocks = await Promise.all(kitEntries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => ({
      kit: entry.name,
      lock: await readFile(new URL(`kits/${entry.name}/pnpm-lock.yaml`, rootUrl), 'utf8'),
    })));

  for (const { kit, lock } of kitLocks) {
    assert.equal(
      lock.includes('https://bnpm.byted.org/'),
      false,
      `${kit}/pnpm-lock.yaml must use a registry reachable by public CI`,
    );
  }
});

test('pnpm locks Linux binaries required by Ubuntu', async () => {
  const [packageText, pnpmLockText] = await Promise.all([
    readFile(packageUrl, 'utf8'),
    readFile(pnpmLockUrl, 'utf8'),
  ]);
  const packageJson = JSON.parse(packageText);
  const lockfile = parseYaml(pnpmLockText);
  const optional = lockfile.importers?.['.']?.optionalDependencies;
  assert.equal(packageJson.optionalDependencies?.['@rollup/rollup-linux-x64-gnu'], '4.60.4');
  assert.equal(optional?.['@rollup/rollup-linux-x64-gnu']?.version, '4.60.4');
  assert.equal(packageJson.optionalDependencies?.['@esbuild/linux-x64'], '0.28.0');
  assert.equal(optional?.['@esbuild/linux-x64']?.version, '0.28.0');
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
  assert.equal(packageJson.scripts['plugins:check'], 'pnpm run plugins:check:framework && pnpm run kits:build');
  assert.equal(packageJson.scripts.test, 'pnpm run test:framework && pnpm run kits:test && pnpm run test:workflows');
  assert.equal(
    packageJson.scripts['test:framework'],
    'pnpm run test:toolchain && pnpm --filter @itharbors/magnet run test && pnpm run test:framework:prepared',
  );
  assert.match(
    packageJson.scripts['test:framework:prepared'],
    /pnpm --filter @itharbors\/server run test/u,
  );
  assert.match(packageJson.scripts['test:preflight'], /--test-reporter=dot/u);
  assert.equal(
    packageJson.scripts['check:preflight'],
    'pnpm run kits:boundary && pnpm run test:preflight',
  );
  assert.equal(
    packageJson.scripts.check,
    'pnpm run build && pnpm run test:framework:prepared && pnpm run test:workflows && pnpm run kits:check && pnpm run plugins:check:framework',
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
