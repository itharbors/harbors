#!/usr/bin/env node
import { execFile } from 'node:child_process';
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repository = fileURLToPath(new URL('..', import.meta.url));
const PRODUCT_VERSION = '0.1.0-preview.1';

const products = Object.freeze({
  sqlite: {
    label: 'SQLite',
    summary: 'SQLite 数据库浏览、编辑、关系图与 SQL 工作台',
    runner: 'macos-14',
    permissions: ['filesystem', 'native-code'],
    target: { platform: 'darwin', arch: 'arm64', nodeAbi: '127' },
    packages: ['sqlite-contracts', 'relationship-graph'],
  },
  mysql: {
    label: 'MySQL',
    summary: 'MySQL 数据库连接、浏览、编辑、关系图与 SQL 工作台',
    runner: 'ubuntu-latest',
    permissions: ['network'],
    target: { platform: 'any', arch: 'any' },
    packages: ['mysql-contracts', 'relationship-graph'],
  },
  notifications: {
    label: 'Notifications',
    summary: '桌面通知中心与 Codex notify-user Skill 安装能力',
    runner: 'ubuntu-latest',
    permissions: ['network', 'filesystem', 'application-startup'],
    target: { platform: 'any', arch: 'any' },
    packages: [],
  },
});

function parseArgs(argv) {
  const result = { skipLock: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--skip-lock') {
      result.skipLock = true;
      continue;
    }
    if (argument !== '--kit' && argument !== '--output') {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${argument}`);
    result[argument === '--kit' ? 'kit' : 'output'] = value;
    index += 1;
  }
  if (!result.kit || !result.output) {
    throw new Error('usage: migrate-kit-product.mjs --kit <sqlite|mysql|notifications> --output <directory> [--skip-lock]');
  }
  return result;
}

async function copySource(source, destination) {
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    filter(candidate) {
      const relative = path.relative(source, candidate);
      if (!relative) return true;
      const segments = relative.split(path.sep);
      const testFixture = segments.includes('tests') && segments.includes('fixtures');
      return !segments.includes('node_modules')
        && (!segments.includes('dist') || testFixture)
        && !segments.includes('.git')
        && !segments.includes('.DS_Store');
    },
  });
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function packageBuildCommands(product) {
  const packages = [
    ...product.packages,
    'kit-core',
    'kit-cli',
  ];
  return packages.map((name) => `npm run build -w @itharbors/${name}`).join(' && ');
}

function packageTestCommands(product) {
  const tested = product.packages.filter((name) => ['relationship-graph'].includes(name));
  tested.push('kit-core', 'kit-cli');
  return tested.map((name) => `npm run test -w @itharbors/${name}`).join(' && ');
}

function productPackage(sourcePackage, kit, product) {
  const notificationBuild = kit === 'notifications'
    ? ' && node scripts/prepare-notification-skill-resource.mjs'
    : '';
  const buildPackages = packageBuildCommands(product);
  return {
    ...sourcePackage,
    version: PRODUCT_VERSION,
    private: true,
    type: 'module',
    workspaces: ['packages/*', 'plugins/*'],
    scripts: {
      'build:packages': buildPackages,
      'plugins:build': 'node scripts/ce-plugin.mjs build --all',
      'plugins:check': 'node scripts/ce-plugin.mjs check --all',
      build: `${buildPackages} && npm run plugins:build${notificationBuild}`,
      'test:product': 'vitest run --config vitest.config.ts',
      'test:toolchain': packageTestCommands(product),
      test: 'npm run build:packages && npm run test:product && npm run test:toolchain',
      check: 'npm run build && npm test && npm run plugins:check',
      'kit:validate': 'node packages/kit-cli/dist/cli.js validate .',
      'kit:pack': 'node packages/kit-cli/dist/cli.js pack .',
    },
    engines: { node: '22.18.0', npm: '10.9.3' },
    harbors: { kitCli: '0.0.1' },
    devDependencies: {
      '@itharbors/kit-cli': '0.0.1',
      '@types/better-sqlite3': '^7.6.0',
      '@types/node': '^22.0.0',
      esbuild: '^0.28.0',
      jsdom: '29.1.1',
      tsx: '^4.0.0',
      typescript: '^5.7.0',
      vitest: '^2.0.0',
    },
  };
}

function productManifest(kit, product) {
  return {
    schemaVersion: 1,
    id: `@itharbors/kit-${kit}`,
    version: PRODUCT_VERSION,
    channel: 'preview',
    publisher: 'itharbors',
    requires: {
      harbors: '>=0.0.1 <0.1.0',
      kitApi: '^1.0.0',
      protocolVersion: 1,
    },
    target: product.target,
    permissions: product.permissions,
    entry: 'package.json',
  };
}

async function transformManifestTest(output, kit) {
  const file = path.join(output, 'tests', 'kit-manifest.test.ts');
  let source = await readFile(file, 'utf8');
  source = source.replace(
    /const projectRoot = fileURLToPath\(new URL\('\.\.\/\.\.\/\.\.', import\.meta\.url\)\);/u,
    'const projectRoot = kitRoot;',
  );
  source = source.replace(
    new RegExp(`npm run test -w @itharbors/kit-${kit}`, 'gu'),
    'vitest run --config vitest.config.ts',
  );
  source = source.replaceAll('rootPackage.scripts.test', "rootPackage.scripts['test:product']");
  if (!source.includes('const projectRoot = kitRoot;')
    || !source.includes("rootPackage.scripts['test:product']")
    || !source.includes('vitest run --config vitest.config.ts')) {
    throw new Error(`Could not adapt ${kit} manifest test to the product root`);
  }
  await writeFile(file, source, 'utf8');
}

async function writeCaller(output, kit, product) {
  let workflow = await readFile(
    path.join(repository, '.github', 'kit-templates', 'publish-kit.yml'),
    'utf8',
  );
  for (const [placeholder, value] of Object.entries({
    __KIT_NAME__: kit,
    __KIT_LABEL__: product.label,
    __KIT_SUMMARY__: product.summary,
    __RUNNER__: product.runner,
  })) workflow = workflow.replaceAll(placeholder, value);
  if (/__[A-Z_]+__/u.test(workflow)) throw new Error('Kit caller still contains template placeholders');
  const directory = path.join(output, '.github', 'workflows');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'publish-kit.yml'), workflow, 'utf8');
}

async function writeNotificationBuildSupport(output) {
  await copySource(
    path.join(repository, '.agents', 'skills', 'notify-user'),
    path.join(output, '.agents', 'skills', 'notify-user'),
  );
  await cp(
    path.join(repository, 'scripts', 'lib', 'codex-skill-resource.mjs'),
    path.join(output, 'scripts', 'lib', 'codex-skill-resource.mjs'),
  );
  await writeFile(
    path.join(output, 'scripts', 'prepare-notification-skill-resource.mjs'),
    `import path from 'node:path';\nimport { fileURLToPath } from 'node:url';\n\nimport { prepareCodexSkillResource } from './lib/codex-skill-resource.mjs';\n\nconst rootDir = fileURLToPath(new URL('..', import.meta.url));\nawait prepareCodexSkillResource({\n  sourceDir: path.join(rootDir, '.agents', 'skills', 'notify-user'),\n  destinationDir: path.join(rootDir, 'plugins', 'notification-background', 'main', 'dist', 'resources', 'notify-user'),\n});\n`,
    'utf8',
  );
}

async function currentCommit() {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repository });
  const commit = stdout.trim();
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error('Could not resolve the Framework source Commit');
  return commit;
}

async function createSnapshot({ kit, output, skipLock }) {
  const product = products[kit];
  if (!product) throw new Error(`Unsupported Kit: ${kit}`);
  const destination = path.resolve(output);
  if (await lstat(destination).catch(() => null)) {
    throw new Error(`output directory already exists: ${destination}`);
  }
  await mkdir(destination, { recursive: true });
  try {
    await copySource(path.join(repository, 'kits', kit), destination);
    await rm(path.join(destination, 'tests', 'runtime-integration.test.ts'), { force: true });
    for (const packageName of [...product.packages, 'kit-core', 'kit-cli']) {
      await copySource(
        path.join(repository, 'packages', packageName),
        path.join(destination, 'packages', packageName),
      );
    }
    await copySource(
      path.join(repository, 'scripts', 'lib', 'plugin-build'),
      path.join(destination, 'scripts', 'lib', 'plugin-build'),
    );
    await cp(path.join(repository, 'scripts', 'ce-plugin.mjs'), path.join(destination, 'scripts', 'ce-plugin.mjs'));
    await cp(path.join(repository, 'tsconfig.json'), path.join(destination, 'tsconfig.json'));
    await copySource(
      path.join(repository, '.agents', 'skills', 'kit-workflow'),
      path.join(destination, '.agents', 'skills', 'kit-workflow'),
    );
    if (kit === 'notifications') await writeNotificationBuildSupport(destination);

    const sourcePackage = JSON.parse(await readFile(path.join(destination, 'package.json'), 'utf8'));
    await writeJson(path.join(destination, 'package.json'), productPackage(sourcePackage, kit, product));
    await writeJson(path.join(destination, 'kit.json'), productManifest(kit, product));
    await writeJson(path.join(destination, '.harbors-product.json'), {
      schemaVersion: 1,
      kit,
      sourceFrameworkCommit: await currentCommit(),
    });
    await transformManifestTest(destination, kit);
    await writeCaller(destination, kit, product);
    await writeFile(
      path.join(destination, '.gitignore'),
      'node_modules/\n**/dist/\n!packages/kit-cli/tests/fixtures/**/dist/\n!packages/kit-cli/tests/fixtures/**/dist/**\ncoverage/\n.worktrees/\n*.hkit\n',
      'utf8',
    );
    await writeFile(
      path.join(destination, 'AGENTS.md'),
      `# Harbors ${product.label} Kit repository instructions\n\nUse the repository-local \`kit-workflow\` Skill for every product change. Base and PR target must remain \`kit/${kit}\`; never target \`main\`.\n\nCommit titles must use exactly one of \`[Init]\`, \`[Feature]\`, \`[Bug]\`, \`[Docs]\`, \`[Refactor]\`, \`[Optimize]\`, \`[Test]\`, or \`[Chore]\`, followed by a concise Chinese summary without a trailing period. \`[Init]\` is initialization-only.\n`,
      'utf8',
    );

    if (!skipLock) {
      await execFileAsync('npm', [
        'install',
        '--package-lock-only',
        '--ignore-scripts',
        '--registry=https://registry.npmjs.org',
      ], {
        cwd: destination,
        maxBuffer: 16 * 1024 * 1024,
      });
    }
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
  return destination;
}

try {
  const result = await createSnapshot(parseArgs(process.argv.slice(2)));
  process.stdout.write(`PRODUCT_DIRECTORY=${result}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
