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
  assert.equal(packageJson.packageManager, 'pnpm@9.12.0');
  assert.equal(packageJson.scripts.kit, 'node packages/kit-cli/dist/cli.js');
  assert.equal(
    packageJson.scripts['kit:check'],
    'pnpm --filter @itharbors/magnet --filter @itharbors/kit-core --filter @itharbors/kit-cli --filter @itharbors/plugin-types --filter @itharbors/host-security --filter @itharbors/server run build && node scripts/check-kit.mjs',
  );
  assert.equal(packageJson.scripts['kit:publish'], undefined);
  assert.equal(packageJson.scripts['kits:validate'], 'pnpm run kit -- validate');
  assert.equal(packageJson.scripts['test:kit-migration'], undefined);
  assert.equal(packageJson.scripts['test:kit-registry-migration'], undefined);
  assert.doesNotMatch(packageJson.scripts.test, /test:kit-(?:registry-)?migration/u);
});

test('default check runs the clean-checkout Kit matrix suite once without dropping public test coverage', async () => {
  const packageJson = JSON.parse(await read('package.json'));
  assert.equal(
    packageJson.scripts['test:kit-check'],
    'node --test scripts/lib/kit-check.test.mjs scripts/lib/kit-matrix.test.mjs',
  );
  assert.match(packageJson.scripts['test:workflows'], /(?:^|&& )pnpm run test:kit-check(?: &&|$)/u);
  assert.match(packageJson.scripts.test, /(?:^|&& )pnpm run test:workflows(?: &&|$)/u);
  assert.match(packageJson.scripts.check, /(?:^|&& )pnpm run test:workflows(?: &&|$)/u);
  assert.match(packageJson.scripts.check, /(?:^|&& )pnpm run kits:check(?: &&|$)/u);
  assert.doesNotMatch(packageJson.scripts.check, /(?:^|&& )pnpm test(?: &&|$)/u);
  assert.doesNotMatch(packageJson.scripts.check, /(?:^|&& )pnpm run kits:(?:test|build)(?: &&|$)/u);
  assert.doesNotMatch(packageJson.scripts.check, /(?:^|&& )pnpm run plugins:check(?: &&|$)/u);
});

test('active Kit docs define one mainline development and local-only Kit lifecycle', async () => {
  const development = compact(await read('docs/guides/development-workflow.md'));
  for (const expected of [
    'main',
    '<type>/<slug>',
    'PR base main',
    '仅更新源码',
    '本地',
    'validate',
    'pack',
    'inspect',
  ]) assert.match(development, new RegExp(expected.replaceAll('/', '\\/'), 'iu'), expected);
  for (const absent of ['release-kit.sh', 'kit/<name>/v<semver>', 'PR 合并即发布']) {
    assert.doesNotMatch(development, new RegExp(absent.replaceAll('/', '\\/'), 'iu'), absent);
  }
});

test('docs navigation and guides define the five-stage Task lifecycle using real commands', async () => {
  const index = compact(await read('docs/README.md'));
  const architecture = compact(await read('docs/architecture/automated-development-workflow.md'));
  const development = compact(await read('docs/guides/development-workflow.md'));
  const tasks = compact(await read('docs/tasks/README.md'));
  const testing = compact(await read('docs/guides/testing.md'));
  const maintenance = compact(await read('docs/guides/maintaining-docs.md'));

  assert.match(index, /\[Task[^\]]*(?:档案|生命周期)[^\]]*\]\(\.\/tasks\/README\.md\)/u);
  const mainStages = ['定义任务', '工作环境确认', '执行计划', '总结沉淀', '交付处理'];
  assert.match(architecture, /定义任务 → 工作环境确认 → 执行计划 → 总结沉淀 → 交付处理/u);
  assert.match(tasks, /一项变更依次经过五段主流程/u);
  for (const stage of mainStages) {
    assert.ok(architecture.includes(stage), `architecture: ${stage}`);
    assert.ok(development.includes(stage), `development: ${stage}`);
    assert.ok(tasks.includes(stage), `tasks: ${stage}`);
  }
  const init = development.indexOf('node scripts/task-status.mjs init feature safe-login');
  const filled = development.indexOf('将输出的 <task-id> 对应的 docs/tasks/<task-id>/task.md 填写完整');
  assert.ok(init >= 0, 'Task init command');
  assert.ok(filled > init, 'Task is filled after init');
  for (const environment of ['current <task-id>', 'worktree <task-id>']) {
    const selection = development.indexOf(`start-change.sh ${environment}`);
    assert.ok(selection > filled, `${environment} is selected after Task is filled`);
  }

  assert.match(architecture, /执行计划 \| `design`、`implementation`、`verification`/u);
  assert.match(tasks, /执行计划覆盖 `design`、`implementation`、`verification`/u);
  for (const action of ['init', 'start', 'complete', 'skip', 'block', 'resume', 'rewind', 'check']) {
    assert.match(tasks, new RegExp(`node scripts/task-status\\.mjs ${action}(?:\\s|$)`, 'u'), action);
  }
  for (const expected of [
    'feature', 'bug', 'optimize', 'docs', 'refactor', 'test', 'chore',
    'task.md', 'status.json', 'summary.md', '.work/',
    '同机', '跨机', 'rewind', 'merged', 'required checks', 'main', 'Codex 会话',
    'start-change.sh',
    '创建 PR', '本地整合', '暂不处理', 'fast-forward', 'merge commit', 'squash',
    'pullRequest: null',
    'git merge --ff-only', 'git merge --no-ff', 'git merge --squash', '合法中文标题',
  ]) assert.ok(development.includes(expected), expected);
  assert.ok(development.includes('打开的 PR 不代表完成'), 'PR is not completion');
  assert.ok(development.includes('先通过 `--ready-for-pr` ready gate'), 'ready gate');
  assert.ok(development.includes('创建 PR、本地整合到 `main`，或暂不处理'), 'delivery choices');
  assert.match(development, /push、创建或更新 PR、以及本地整合都要取得对应的明确授权/u);
  for (const finding of ['blocking', 'non_blocking', 'decision_candidates', 'follow_up']) {
    assert.ok(architecture.includes(finding), `architecture: ${finding}`);
    assert.ok(development.includes(finding), `development: ${finding}`);
    assert.ok(tasks.includes(finding), `tasks: ${finding}`);
  }
  assert.match(testing, /pullRequest: null[^。]{0,80}(?:有效|允许)/u);
  for (const prose of [architecture, development, tasks, testing]) {
    assert.doesNotMatch(prose, /finish-change\.sh/u);
    assert.doesNotMatch(prose, /PR_URL=/u);
  }

  for (const expected of ['Task 正式档案', '.work/', 'spec', 'plan', 'research']) {
    assert.ok(maintenance.includes(expected), expected);
  }
  assert.match(maintenance, /\.work\/[^。]{0,100}(?:默认|不)[^。]{0,30}(?:提交|跟踪)/u);
  assert.match(maintenance, /(?:架构|安全|迁移|维护)[^。]{0,160}(?:guide|reference|ADR|设计文档)/iu);
  assert.match(maintenance, /不能只留在[^。]{0,80}(?:\.work\/|summary)/u);
});

test('artifact and authoring guides document descriptor discovery and local packaging', async () => {
  const artifacts = compact(await read('docs/guides/kit-artifacts.md'));
  const authoring = compact(await read('docs/guides/developing-plugins-and-kits.md'));
  const combined = `${artifacts} ${authoring}`;
  for (const expected of [
    'descriptor',
    'distribution',
    'kits/',
    '.hkit',
  ]) assert.ok(combined.includes(expected), expected);
  for (const command of [' validate ', ' pack ', ' inspect ']) {
    assert.match(artifacts, new RegExp(`pnpm run kit --${command}`, 'u'));
  }
  for (const absent of [
    'Release Asset',
    'registry/policy',
    'registry/revocations',
    'index.v1.json',
    'GitHub Pages',
    'attestations/sha256',
    'actions/attest',
    'release-kit.sh',
  ]) assert.doesNotMatch(combined, new RegExp(absent.replaceAll('/', '\\/'), 'iu'), absent);
});

test('root README and architecture describe dynamic descriptors and local discovery', async () => {
  const readme = compact(await read('readme.md'));
  const architecture = compact(await read('docs/architecture/kit-and-session-model.md'));
  for (const expected of [
    'descriptor',
    'distribution',
    'kits/',
  ]) assert.match(`${readme} ${architecture}`, new RegExp(expected.replaceAll('/', '\\/'), 'iu'), expected);
  assert.match(`${readme} ${architecture}`, /(扫描|发现)[^。]{0,80}(Kit|builtin|本地)/iu);
});

test('active sources and root docs contain no central builtin constants or product slug tables', async () => {
  await assert.rejects(access(new URL('scripts/lib/builtin-kits.mjs', repositoryRoot)));
  const sourcePaths = [
    'scripts/ce-plugin.mjs',
    'scripts/dev.mjs',
    'scripts/lib/plugin-build/discover.mjs',
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
    'docs/architecture/layout-model.md',
    'docs/architecture/plugin-runtime-model.md',
  ];
  const sources = await Promise.all(sourcePaths.map(read));
  const prose = await Promise.all(rootDocs.map(read));
  const artifactGuide = await read('docs/guides/kit-artifacts.md');
  assert.doesNotMatch(sources.join('\n'), /BUILTIN_KITS|BUILTIN_KIT_IDS/u);
  assert.doesNotMatch(
    [...sources, ...prose].join('\n'),
    /kits\/(?:agent-guard|csv|mysql|notifications|scheduler|skill-manager|sqlite|traceweave)/u,
  );
  assert.doesNotMatch(
    prose.join('\n'),
    /@itharbors\/kit-(?:agent-guard|csv|mysql|notifications|scheduler|skill-manager|sqlite|traceweave)/u,
  );
  assert.doesNotMatch(prose.join('\n'), /根\s*`?package-lock\.json`?/u);
  assert.doesNotMatch(artifactGuide, /Default builtin/iu);
  assert.match(artifactGuide, /所有 Kit 从 `kits\/` 目录进行本地开发与打包/iu);
  assert.doesNotMatch(
    prose.join('\n'),
    /^(?:[│├└].*\b(?:Agent Guard|CSV|MySQL|Notifications|Scheduler|Skill Manager|SQLite|TraceWeave)\b.*)$/gmu,
  );
  assert.doesNotMatch(
    prose.join('\n'),
    /(?:Agent Guard|CSV|MySQL|Notifications|Scheduler|Skill Manager|SQLite|TraceWeave)(?:、|,|，| 和 | 与 ).*(?:Agent Guard|CSV|MySQL|Notifications|Scheduler|Skill Manager|SQLite|TraceWeave)/u,
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
      `pnpm --dir kits/${entry.name} install --frozen-lockfile`,
      `pnpm --dir kits/${entry.name} run ${descriptor.scripts.build}`,
      `pnpm --dir kits/${entry.name} run ${descriptor.scripts.test}`,
    ]) assert.ok(contents.includes(command), `${relative}: ${command}`);
    if (descriptor.scripts.smoke) {
      assert.ok(contents.includes(`pnpm --dir kits/${entry.name} run smoke`), `${relative}: smoke`);
    } else {
      assert.match(contents, /完整检查|full check/iu, `${relative}: full check`);
    }
    for (const heading of ['Permissions', 'Platform', 'Ownership boundary']) {
      assert.match(contents, new RegExp(`^## ${heading}$`, 'mu'), `${relative}: ${heading}`);
    }
  }
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
    'docs/architecture/runtime-flows.md',
  ];
  const prose = compact((await Promise.all(paths.map(read))).join('\n'));
  for (const obsolete of [
    /PR base kit\/(?:agent-guard|csv|mysql|notifications|scheduler|skill-manager|sqlite|traceweave)/iu,
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
