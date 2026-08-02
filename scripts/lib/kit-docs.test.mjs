import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { discoverRepositoryKits } from './repository-kits.mjs';

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
    'npm run build -w @itharbors/kit-core -w @itharbors/kit-cli -w @itharbors/server && node scripts/check-kit.mjs',
  );
  assert.equal(packageJson.scripts['kit:publish'], 'node scripts/kit-publish.mjs');
  assert.equal(packageJson.scripts['kits:validate'], 'npm run kit -- validate');
  assert.equal(packageJson.scripts['test:kit-migration'], undefined);
  assert.equal(packageJson.scripts['test:kit-registry-migration'], undefined);
  assert.doesNotMatch(packageJson.scripts.test, /test:kit-(?:registry-)?migration/u);
});

test('active Kit docs define one mainline development and automatic merge release lifecycle', async () => {
  const development = compact(await read('docs/guides/development-workflow.md'));
  for (const expected of [
    'main',
    'kit-change/<name>/<type>/<slug>',
    'PR base main',
    'PR 合并即发布授权',
    'kits/<name>/kit.json',
    'kits/<name>/package.json',
    'kits/<name>/package-lock.json',
    '自动创建',
    'release-kit.sh',
    'kit/<name>/v<semver>',
  ]) assert.match(development, new RegExp(expected.replaceAll('/', '\\/'), 'iu'), expected);
  assert.match(development, /Kit[^。]{0,80}Framework[^。]{0,80}版本/iu);
  assert.match(development, /共享[^。]{0,80}(全部|所有)[^。]{0,30}Kit[^。]{0,20}CI/iu);
});

test('artifact and authoring guides document descriptor discovery and trusted Release discovery', async () => {
  const artifacts = compact(await read('docs/guides/kit-artifacts.md'));
  const authoring = compact(await read('docs/guides/developing-plugins-and-kits.md'));
  const combined = `${artifacts} ${authoring}`;
  for (const expected of [
    'descriptor',
    'distribution',
    'kits/',
    'kit/<name>/v<semver>',
    '.hkit',
    'Release Asset',
    'registry/policy.json',
    'registry/revocations.json',
    'index.v1.json',
    'https://itharbors.github.io/harbors/index.v1.json',
  ]) assert.ok(combined.includes(expected), expected);
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

test('root README and architecture describe dynamic descriptors and automatic market projection', async () => {
  const readme = compact(await read('readme.md'));
  const architecture = compact(await read('docs/architecture/kit-and-session-model.md'));
  for (const expected of [
    'descriptor',
    'distribution',
    'kits/',
    'kit/<name>/v<semver>',
    'Release Asset',
    'index.v1.json',
    'registry/policy.json',
    'registry/revocations.json',
  ]) assert.match(`${readme} ${architecture}`, new RegExp(expected.replaceAll('/', '\\/'), 'iu'), expected);
  assert.match(`${readme} ${architecture}`, /自动[^。]{0,80}(扫描|发现)[^。]{0,80}Release/iu);
});

test('active sources and root docs contain no central builtin constants or product slug tables', async () => {
  await assert.rejects(access(new URL('scripts/lib/builtin-kits.mjs', repositoryRoot)));
  const sourcePaths = [
    'scripts/ce-plugin.mjs',
    'scripts/dev.mjs',
    'scripts/electron.mjs',
    'scripts/lib/kit-catalog.mjs',
    'scripts/lib/plugin-build/discover.mjs',
    'scripts/lib/desktop-build.mjs',
    'packages/kit-cli/src/plugin-build/discover.ts',
  ];
  const rootDocs = [
    'readme.md',
    'docs/README.md',
    'docs/architecture/system-overview.md',
    'docs/architecture/kit-and-session-model.md',
    'docs/guides/developing-plugins-and-kits.md',
    'docs/guides/development-workflow.md',
    'docs/guides/kit-artifacts.md',
    'docs/guides/app-releases.md',
    'docs/architecture/layout-model.md',
    'docs/architecture/plugin-runtime-model.md',
  ];
  const sources = await Promise.all(sourcePaths.map(read));
  const prose = await Promise.all(rootDocs.map(read));
  const artifactGuide = await read('docs/guides/kit-artifacts.md');
  assert.doesNotMatch(sources.join('\n'), /BUILTIN_KITS|BUILTIN_KIT_IDS/u);
  assert.doesNotMatch(
    [...sources, ...prose].join('\n'),
    /kits\/(?:agent-guard|csv|default|mysql|notifications|scheduler|skill-manager|sqlite|traceweave)/u,
  );
  assert.doesNotMatch(
    prose.join('\n'),
    /@itharbors\/kit-(?:agent-guard|csv|default|mysql|notifications|scheduler|skill-manager|sqlite|traceweave)/u,
  );
  assert.doesNotMatch(prose.join('\n'), /根\s*`?package-lock\.json`?/u);
  assert.doesNotMatch(artifactGuide, /Default builtin/iu);
  assert.match(artifactGuide, /所有动态发现的 builtin Kit 目录[^。]+恰好一个声明 default 角色/iu);
  assert.doesNotMatch(
    prose.join('\n'),
    /^(?:[│├└].*\b(?:Agent Guard|CSV|Default|MySQL|Notifications|Scheduler|Skill Manager|SQLite|TraceWeave)\b.*)$/gmu,
  );
  assert.doesNotMatch(
    prose.join('\n'),
    /(?:Agent Guard|CSV|Default|MySQL|Notifications|Scheduler|Skill Manager|SQLite|TraceWeave)(?:、|,|，| 和 | 与 ).*(?:Agent Guard|CSV|Default|MySQL|Notifications|Scheduler|Skill Manager|SQLite|TraceWeave)/u,
  );
});

test('every Kit README owns its lifecycle, permissions, platform, and boundary contract', async () => {
  const descriptors = await discoverRepositoryKits({
    repositoryRoot: new URL('../../', import.meta.url).pathname,
  });
  const kitEntries = await readdir(new URL('kits/', repositoryRoot), { withFileTypes: true });
  for (const entry of kitEntries.filter((item) => item.isDirectory())) {
    const relative = `kits/${entry.name}/README.md`;
    const contents = await read(relative);
    const descriptor = descriptors.find((item) => item.slug === entry.name);
    for (const command of [
      `npm ci --prefix kits/${entry.name}`,
      `npm run ${descriptor.scripts.build} --prefix kits/${entry.name}`,
      `npm run ${descriptor.scripts.test} --prefix kits/${entry.name}`,
    ]) assert.ok(contents.includes(command), `${relative}: ${command}`);
    if (descriptor.scripts.smoke) {
      assert.ok(contents.includes(`npm run smoke --prefix kits/${entry.name}`), `${relative}: smoke`);
    } else {
      assert.match(contents, /完整检查|full check/iu, `${relative}: full check`);
    }
    for (const heading of ['Permissions', 'Platform', 'Ownership boundary']) {
      assert.match(contents, new RegExp(`^## ${heading}$`, 'mu'), `${relative}: ${heading}`);
    }
  }
});

test('CSV Kit documentation states its read-only parsing, query, export, and resource contract', async () => {
  const csv = compact(await read('kits/csv/README.md'));
  for (const expected of [
    '.csv',
    '.tsv',
    '.txt',
    'UTF-8',
    'GB18030',
    '只读',
    '不修改源文件',
    '不规则记录',
    'contains',
    'equals',
    'is-empty',
    'is-not-empty',
    'UTF-8 BOM',
    '2 GiB',
    '10,000',
    '16 MiB',
    'npm run dev -- --kit ./kits/csv',
  ]) assert.match(csv, new RegExp(expected.replaceAll('/', '\\/'), 'iu'), expected);
  assert.match(csv, /逗号[^。]{0,40}制表符[^。]{0,40}分号/iu);
  assert.match(csv, /“导出当前结果”[^。]{0,80}新的/iu);
  assert.match(csv, /不会覆盖源文件/iu);
});

test('Skill Manager documentation states its source, state, and recovery boundaries', async () => {
  const skillManager = compact(await read('kits/skill-manager/README.md'));
  const architecture = compact(await read('docs/architecture/kit-and-session-model.md'));
  const combined = `${skillManager} ${architecture}`;
  for (const expected of [
    '$CODEX_HOME/skills',
    '~/.codex/skills',
    '$CODEX_HOME/skill-manager-store/v1',
    'source-only',
    'current',
    'update-available',
    'global-only',
    'disabled',
    'trashed',
    'protected',
    'conflict',
    'invalid',
    '.system',
    'npm run dev -- --kit ./kits/skill-manager',
  ]) assert.ok(combined.includes(expected), expected);
  assert.match(combined, /来源目录[^。]{0,80}(当前|本次) Session/iu);
  assert.match(combined, /不[^。]{0,80}(永久删除|不可恢复)/iu);
  assert.match(combined, /Renderer[^。]{0,80}(原始|真实)[^。]{0,30}路径/iu);
  assert.match(combined, /(不访问|不会访问|不支持)[^。]{0,80}(网络|GitHub)/iu);
});

test('active official-Kit docs do not retain exact-three lists that omit CSV', async () => {
  const prose = compact((await Promise.all([
    'readme.md',
    'docs/guides/development-workflow.md',
    'docs/guides/kit-artifacts.md',
    'docs/guides/developing-plugins-and-kits.md',
  ].map(read))).join('\n'));
  assert.doesNotMatch(prose, /(?:^|\s)SQLite、MySQL、Notifications\s+(?:分别|的发布源)/iu);
  assert.doesNotMatch(prose, /(?:^|\s)SQLite、MySQL 和 Notifications\s+分别/iu);
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
