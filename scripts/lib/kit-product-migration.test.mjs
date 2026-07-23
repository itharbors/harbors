import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const repository = path.resolve(new URL('../..', import.meta.url).pathname);
const migrationScript = path.join(repository, 'scripts/migrate-kit-product.mjs');

async function generate(kit) {
  const temp = await mkdtemp(path.join(os.tmpdir(), `harbors-${kit}-product-`));
  const output = path.join(temp, kit);
  await execFileAsync(process.execPath, [
    migrationScript,
    '--kit', kit,
    '--output', output,
    '--skip-lock',
  ], { cwd: repository });
  return { temp, output };
}

async function json(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function listTree(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await listTree(path.join(directory, entry.name), relative));
    else files.push(relative);
  }
  return files.sort();
}

test('generates an isolated SQLite product rooted at the Kit', async (context) => {
  const { temp, output } = await generate('sqlite');
  context.after(() => rm(temp, { recursive: true, force: true }));

  const manifest = await json(path.join(output, 'kit.json'));
  const pkg = await json(path.join(output, 'package.json'));
  const provenance = await json(path.join(output, '.harbors-product.json'));
  const workflow = await readFile(path.join(output, '.github/workflows/publish-kit.yml'), 'utf8');
  const manifestTest = await readFile(path.join(output, 'tests/kit-manifest.test.ts'), 'utf8');
  const gitignore = await readFile(path.join(output, '.gitignore'), 'utf8');
  const tree = await listTree(output);

  assert.equal(manifest.id, '@itharbors/kit-sqlite');
  assert.equal(manifest.version, '0.1.0-preview.1');
  assert.equal(manifest.channel, 'preview');
  assert.deepEqual(manifest.permissions, ['filesystem', 'native-code']);
  assert.deepEqual(manifest.target, { platform: 'darwin', arch: 'arm64', nodeAbi: '127' });
  assert.equal(pkg.name, manifest.id);
  assert.equal(pkg.version, manifest.version);
  assert.deepEqual(pkg.workspaces, ['packages/*', 'plugins/*']);
  assert.equal(pkg.engines.node, '22.18.0');
  assert.equal(pkg.engines.npm, '10.9.3');
  assert.equal(pkg.harbors.kitCli, '0.0.1');
  assert.equal(pkg.devDependencies.tsx, '^4.0.0');
  assert.match(pkg.scripts.check, /npm run build.*npm test.*plugins:check/u);
  assert.match(pkg.scripts['kit:validate'], /kit-cli\/dist\/cli\.js validate \./u);
  assert.match(workflow, /kit-name:\s*sqlite/u);
  assert.match(workflow, /runner:\s*macos-14/u);
  assert.match(workflow, /branches:\s*\n\s*- kit\/sqlite/u);
  assert.equal(provenance.kit, 'sqlite');
  assert.match(provenance.sourceFrameworkCommit, /^[a-f0-9]{40}$/u);
  assert.match(manifestTest, /const projectRoot = kitRoot;/u);
  assert.match(manifestTest, /scripts\['test:product'\]/u);
  assert.match(manifestTest, /vitest run --config vitest\.config\.ts/u);
  assert.ok(tree.includes('plugins/sqlite-core/main/src/index.ts'));
  assert.ok(tree.includes('packages/sqlite-contracts/src/index.ts'));
  assert.ok(tree.includes('packages/relationship-graph/src/index.ts'));
  assert.ok(tree.includes('packages/kit-cli/src/cli.ts'));
  assert.ok(tree.includes('packages/kit-cli/tests/fixtures/minimal-kit/plugins/demo/main/dist/index.js'));
  assert.match(gitignore, /!packages\/kit-cli\/tests\/fixtures\/\*\*\/dist\/\*\*/u);
  assert.ok(tree.includes('.agents/skills/kit-workflow/scripts/start-kit-change.sh'));
  assert.ok(!tree.includes('tests/runtime-integration.test.ts'));
  assert.ok(!tree.some((file) => file.includes('/node_modules/')));
  assert.ok(!tree.some((file) => /^plugins\/.*\/dist\//u.test(file)));
  assert.ok(!tree.some((file) => /^packages\/[^/]+\/dist\//u.test(file)));
  assert.ok(!tree.includes('package-lock.json'));

  await execFileAsync('git', ['init', '-q'], { cwd: output });
  await assert.rejects(
    execFileAsync('git', ['check-ignore', 'packages/kit-cli/tests/fixtures/minimal-kit/plugins/demo/main/dist/index.js'], { cwd: output }),
  );
  const ignored = await execFileAsync(
    'git',
    ['check-ignore', '--no-index', 'plugins/sqlite-core/main/dist/index.js'],
    { cwd: output },
  );
  assert.match(ignored.stdout, /plugins\/sqlite-core\/main\/dist\/index\.js/u);
});

test('generates MySQL and Notifications with minimal product-specific capabilities', async (context) => {
  const mysql = await generate('mysql');
  const notifications = await generate('notifications');
  context.after(() => Promise.all([
    rm(mysql.temp, { recursive: true, force: true }),
    rm(notifications.temp, { recursive: true, force: true }),
  ]));

  const mysqlManifest = await json(path.join(mysql.output, 'kit.json'));
  const mysqlTree = await listTree(mysql.output);
  assert.deepEqual(mysqlManifest.permissions, ['network']);
  assert.deepEqual(mysqlManifest.target, { platform: 'any', arch: 'any' });
  assert.ok(mysqlTree.includes('packages/mysql-contracts/src/index.ts'));
  assert.ok(mysqlTree.includes('packages/relationship-graph/src/index.ts'));
  assert.ok(!mysqlTree.includes('tests/runtime-integration.test.ts'));
  assert.ok(!mysqlTree.some((file) => file.includes('sqlite-contracts')));

  const notificationManifest = await json(path.join(notifications.output, 'kit.json'));
  const notificationPkg = await json(path.join(notifications.output, 'package.json'));
  const notificationTree = await listTree(notifications.output);
  assert.deepEqual(notificationManifest.permissions, ['network', 'filesystem', 'application-startup']);
  assert.deepEqual(notificationManifest.target, { platform: 'any', arch: 'any' });
  assert.match(notificationPkg.scripts.build, /prepare-notification-skill-resource/u);
  assert.ok(notificationTree.includes('.agents/skills/notify-user/SKILL.md'));
  assert.ok(notificationTree.includes('scripts/prepare-notification-skill-resource.mjs'));
  assert.ok(!notificationTree.some((file) => file.includes('relationship-graph')));
  assert.ok(!notificationTree.some((file) => file.includes('-contracts')));
});

test('rejects unknown Kits and refuses to overwrite output', async (context) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'harbors-product-invalid-'));
  context.after(() => rm(temp, { recursive: true, force: true }));
  const output = path.join(temp, 'occupied');
  await mkdir(output);
  await writeFile(path.join(output, 'keep.txt'), 'owned\n');

  await assert.rejects(
    execFileAsync(process.execPath, [migrationScript, '--kit', '../sqlite', '--output', path.join(temp, 'bad')], { cwd: repository }),
    /Unsupported Kit/u,
  );
  await assert.rejects(
    execFileAsync(process.execPath, [migrationScript, '--kit', 'sqlite', '--output', output], { cwd: repository }),
    /output directory already exists/u,
  );
  assert.equal(await readFile(path.join(output, 'keep.txt'), 'utf8'), 'owned\n');
});
