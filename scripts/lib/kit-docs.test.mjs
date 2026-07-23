import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const repositoryRoot = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, repositoryRoot), 'utf8');
}

function compact(value) {
  return value.replace(/\s+/gu, ' ');
}

test('root scripts expose the Kit artifact and targeted-check CLIs without migration commands', async () => {
  const packageJson = JSON.parse(await read('package.json'));
  assert.equal(packageJson.scripts.kit, 'node packages/kit-cli/dist/cli.js');
  assert.equal(
    packageJson.scripts['kit:check'],
    'npm run build -w @itharbors/kit-core && node scripts/check-kit.mjs',
  );
  assert.equal(packageJson.scripts['kit:publish'], 'node scripts/kit-publish.mjs');
  assert.equal(packageJson.scripts['kits:validate'], 'npm run kit -- validate');
  assert.equal(packageJson.scripts['test:kit-migration'], undefined);
  assert.equal(packageJson.scripts['test:kit-registry-migration'], undefined);
  assert.doesNotMatch(packageJson.scripts.test, /test:kit-(?:registry-)?migration/u);
});

test('active Kit docs define one mainline development and Tag release lifecycle', async () => {
  const development = compact(await read('docs/guides/development-workflow.md'));
  for (const expected of [
    'main',
    'kit-change/<name>/<type>/<slug>',
    'PR base main',
    'merge without Release',
    'kits/<name>/kit.json',
    'kits/<name>/package.json',
    'release-kit.sh',
    'kit/<name>/v<semver>',
  ]) assert.match(development, new RegExp(expected.replaceAll('/', '\\/'), 'iu'), expected);
  assert.match(development, /Kit[^。]{0,80}Framework[^。]{0,80}版本/iu);
  assert.match(development, /共享[^。]{0,80}(全部|所有)[^。]{0,30}Kit[^。]{0,20}CI/iu);
});

test('artifact and authoring guides document monorepo Kits and trusted Release discovery', async () => {
  const artifacts = compact(await read('docs/guides/kit-artifacts.md'));
  const authoring = compact(await read('docs/guides/developing-plugins-and-kits.md'));
  const combined = `${artifacts} ${authoring}`;
  for (const expected of [
    'kits/sqlite',
    'kits/mysql',
    'kits/notifications',
    'kit/<name>/v<semver>',
    '.hkit',
    'Release Asset',
    'registry/policy.json',
    'registry/revocations.json',
    'index.v1.json',
    'https://itharbors.github.io/harbors/index.v1.json',
  ]) assert.match(combined, new RegExp(expected.replaceAll('/', '\\/'), 'iu'), expected);
  for (const command of [' validate ', ' pack ', ' inspect ']) {
    assert.match(artifacts, new RegExp(`npm run kit --${command}`, 'u'));
  }
  for (const guarantee of [
    'Release',
    '可信',
    'GitHub Pages',
    'GitHubArtifactAttestationVerifier',
    'KitReleaseResolver',
    'KitArtifactDownloader',
    'KitRegistryManager',
    'actions/attest@v4',
    'pending',
    'bad',
    'audit.ndjson',
    'start-kit-change.sh',
    'finish-kit-change.sh',
    'release-kit.sh',
  ]) assert.match(artifacts, new RegExp(guarantee, 'iu'), guarantee);
});

test('root README and architecture describe Release Assets and automatic market projection', async () => {
  const readme = compact(await read('readme.md'));
  const architecture = compact(await read('docs/architecture/kit-and-session-model.md'));
  for (const expected of [
    'kits/sqlite',
    'kits/mysql',
    'kits/notifications',
    'kit/<name>/v<semver>',
    'Release Asset',
    'index.v1.json',
    'registry/policy.json',
    'registry/revocations.json',
  ]) assert.match(`${readme} ${architecture}`, new RegExp(expected.replaceAll('/', '\\/'), 'iu'), expected);
  assert.match(`${readme} ${architecture}`, /自动[^。]{0,80}(扫描|发现)[^。]{0,80}Release/iu);
});

test('active docs contain no branch-era migration or publication instructions', async () => {
  const paths = [
    'readme.md',
    'docs/guides/development-workflow.md',
    'docs/guides/kit-artifacts.md',
    'docs/guides/developing-plugins-and-kits.md',
    'docs/architecture/kit-and-session-model.md',
  ];
  const prose = compact((await Promise.all(paths.map(read))).join('\n'));
  for (const obsolete of [
    /PR base kit\/(?:sqlite|mysql|notifications)/iu,
    /push kit\/<name>[^。]{0,40}Preview/iu,
    /migrate-kit-product\.mjs/iu,
    /migrate-kit-registry\.mjs/iu,
    /HEAD:kit-registry/iu,
    /--base kit-registry/iu,
    /origin\/kit\/<kit>/iu,
    /preview\/<name>/iu,
    /\.github\/kit-templates/iu,
    /产品分支/iu,
  ]) assert.doesNotMatch(prose, obsolete);
});
