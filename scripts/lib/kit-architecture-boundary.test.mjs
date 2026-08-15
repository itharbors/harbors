import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { auditKitArchitecture } from './kit-architecture-boundary.mjs';
import { runKitArchitectureCli } from '../check-kit-architecture.mjs';

async function write(root, relativePath, contents) {
  const destination = path.join(root, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, contents);
}

async function makeKit(root, slug, options = {}) {
  await write(root, `kits/${slug}/kit.json`, JSON.stringify({
    id: `dev.harbors.${slug}`,
    distribution: slug === 'default' ? 'builtin' : 'market',
  }));
  await write(root, `kits/${slug}/package.json`, JSON.stringify({
    name: `@fixture/kit-${slug}`,
    version: '1.0.0',
    dependencies: options.dependencies ?? { '@itharbors/kit-core': '^1.0.0' },
    workspaces: options.workspaces,
  }));
  if (options.lock !== false) await write(root, `kits/${slug}/package-lock.json`, '{}');
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-kit-architecture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('reports every normalized architecture violation in deterministic policy order', async (t) => {
  const root = await fixture(t);
  await makeKit(root, 'alpha', {
    dependencies: {
      '@itharbors/kit-core': '^1.0.0',
      private: 'file:../../../packages/private',
    },
  });
  await makeKit(root, 'zeta', { lock: false });
  await write(root, 'kits/alpha/src/index.ts', [
    "export { value } from '../../zeta/src/value.js';",
  ].join('\n'));
  await write(root, 'packages/framework/src/environment.ts',
    'export const port = process.env.HARBORS_ZETA_PORT;\nexport const notification = process.env.HARBORS_NOTIFICATION_PORT;\n');
  await write(root, 'scripts/catalog.mjs', "export const kitSlugs = ['zeta', 'alpha'];\n");
  await write(root, 'registry/policy.json', JSON.stringify({ trustedKitIds: ['dev.harbors.alpha'] }));

  const result = await auditKitArchitecture({ repositoryRoot: root });
  assert.deepEqual(result.errors.map((error) => error.code), [
    'KIT_CROSS_IMPORT',
    'KIT_LOCAL_DEPENDENCY_ESCAPE',
    'KIT_LOCK_MISSING',
    'FRAMEWORK_KIT_SPECIAL_CASE',
    'STATIC_KIT_REGISTRY',
  ]);
  assert.deepEqual(result.errors, [...result.errors].sort((left, right) =>
    left.order - right.order || left.path.localeCompare(right.path) || left.message.localeCompare(right.message)));
});

test('detects production equality, switch, and semantic-variable Kit special cases only', async (t) => {
  const root = await fixture(t);
  await makeKit(root, 'alpha');
  await makeKit(root, 'zeta');
  await write(root, 'packages/framework/src/special.ts', [
    "const ordinary = 'zeta';",
    "if (productivityMode === 'zeta') throw new Error('ordinary');",
    "if (toolkitName === 'alpha') throw new Error('ordinary');",
    "// if (kitSlug === 'zeta') comment only",
    "if (requestedKit === 'zeta') throw new Error('special');",
    "switch (kitSlug) { case 'alpha': break; }",
    "const productId = 'dev.harbors.zeta';",
  ].join('\n'));
  await write(root, 'packages/framework/src/notification.ts', "if (notificationKitName === 'zeta') throw new Error();\n");
  await write(root, 'packages/framework/src/zeta.ts', "const zetaKit = 'zeta';\n");
  await write(root, 'packages/framework/src/owner.ts', "const ownerKit = 'alpha';\n");
  await write(root, 'packages/framework/src/descriptors.ts', "const KIT_DESCRIPTORS = ['alpha'];\n");
  await write(root, 'packages/framework/src/map.ts', "const KIT_MAP = new Map([['zeta', true]]);\n");
  await write(root, 'packages/framework/src/ordinary.ts', [
    "const toolkits = ['zeta'];",
    "const byproducts = ['alpha'];",
  ].join('\n'));
  const result = await auditKitArchitecture({ repositoryRoot: root });
  assert.deepEqual(
    result.errors.filter((entry) => entry.code === 'FRAMEWORK_KIT_SPECIAL_CASE').map((entry) => entry.path),
    [
      'packages/framework/src/notification.ts',
      'packages/framework/src/owner.ts',
      'packages/framework/src/special.ts',
      'packages/framework/src/zeta.ts',
    ],
  );
  assert.deepEqual(
    result.errors.filter((entry) => entry.code === 'STATIC_KIT_REGISTRY').map((entry) => entry.path),
    ['packages/framework/src/descriptors.ts', 'packages/framework/src/map.ts'],
  );
});

test('detects semantic Kit identities in class, object, and assignment properties', async (t) => {
  const root = await fixture(t);
  await makeKit(root, 'zeta');
  await makeKit(root, 'default');
  await write(root, 'kits/default/kit.json', JSON.stringify({
    id: 'default',
    distribution: 'market',
  }));
  await write(root, 'packages/framework/src/class-property.ts',
    "class Options { notificationKitName = 'zeta'; }\n");
  await write(root, 'packages/framework/src/assignment.ts',
    "config.notificationKitName = 'default';\n");
  await write(root, 'packages/framework/src/object-property.ts',
    "const options = { notificationKitName: 'zeta' };\n");
  const result = await auditKitArchitecture({ repositoryRoot: root });
  assert.deepEqual(
    result.errors.filter((entry) => entry.code === 'FRAMEWORK_KIT_SPECIAL_CASE').map((entry) => entry.path),
    [
      'packages/framework/src/assignment.ts',
      'packages/framework/src/class-property.ts',
      'packages/framework/src/object-property.ts',
    ],
  );
});

test('parses supported import forms and ignores comments and ordinary strings', async (t) => {
  const root = await fixture(t);
  await makeKit(root, 'alpha');
  await makeKit(root, 'zeta');
  await write(root, 'kits/alpha/src/imports.tsx', [
    "import target from '@fixture/kit-zeta';",
    "export * from '@fixture/kit-zeta/exported';",
    "const dynamic = import('../../zeta/dynamic.mjs');",
    "const required = require('../../zeta/required.cjs');",
    "import Legacy = require('@fixture/kit-zeta/legacy');",
    "// import '../../zeta/comment.js'",
    "const text = \"require('../../zeta/string.js')\";",
    "const template = `import '../../zeta/template.js'`;",
  ].join('\n'));

  const result = await auditKitArchitecture({ repositoryRoot: root, targetKit: 'alpha' });
  assert.equal(result.errors.filter((error) => error.code === 'KIT_CROSS_IMPORT').length, 5);
});

test('rejects Framework-private imports and repository paths to another Kit', async (t) => {
  const root = await fixture(t);
  await makeKit(root, 'alpha');
  await makeKit(root, 'zeta');
  await write(root, 'kits/alpha/src/private.ts', [
    "import path from 'node:path';",
    "const { resolve: locate } = path;",
    "import '../../../packages/server/src/editor/index.ts';",
    "const fixture = locate(projectRoot, 'kits', 'zeta');",
    "const unrelated = database.resolve(projectRoot, 'kits', 'zeta');",
    "const privateHarness = new URL('../../../packages/server/src/testing.ts', import.meta.url);",
  ].join('\n'));
  const result = await auditKitArchitecture({ repositoryRoot: root, targetKit: 'alpha' });
  assert.deepEqual(result.errors.map((entry) => entry.code), [
    'KIT_CROSS_IMPORT',
    'KIT_LOCAL_DEPENDENCY_ESCAPE',
    'KIT_LOCAL_DEPENDENCY_ESCAPE',
  ]);
});

test('tracks node:path aliases lexically and ignores shadowed parameters and unrelated methods', async (t) => {
  const root = await fixture(t);
  await makeKit(root, 'alpha');
  await makeKit(root, 'zeta');
  await write(root, 'kits/alpha/src/path-alias.ts', [
    "import legacyPath = require('path');",
    'const locate = legacyPath.resolve;',
    "const escaped = locate(projectRoot, 'kits', 'zeta');",
    "function shadowFunction(locate) { return locate(projectRoot, 'kits', 'zeta'); }",
    "function shadowObject(legacyPath) { return legacyPath.resolve(projectRoot, 'kits', 'zeta'); }",
    "const unrelated = database.resolve(projectRoot, 'kits', 'zeta');",
  ].join('\n'));
  const result = await auditKitArchitecture({ repositoryRoot: root, targetKit: 'alpha' });
  assert.deepEqual(result.errors.map((entry) => entry.code), ['KIT_CROSS_IMPORT']);
});

test('allows independently owned copies of one package name but rejects non-owner imports', async (t) => {
  const root = await fixture(t);
  for (const slug of ['alpha', 'beta', 'zeta']) await makeKit(root, slug);
  await write(root, 'kits/beta/packages/shared/package.json', JSON.stringify({ name: '@fixture/shared' }));
  await write(root, 'kits/zeta/packages/shared/package.json', JSON.stringify({ name: '@fixture/shared' }));
  await write(root, 'kits/beta/src/index.ts', "import '@fixture/shared';\n");
  await write(root, 'kits/alpha/src/index.ts', "import '@fixture/shared';\n");
  assert.deepEqual((await auditKitArchitecture({ repositoryRoot: root, targetKit: 'beta' })).errors, []);
  assert.deepEqual(
    (await auditKitArchitecture({ repositoryRoot: root, targetKit: 'alpha' })).errors.map((entry) => entry.code),
    ['KIT_CROSS_IMPORT'],
  );
});

test('target audit is independent from malformed and unlocked unrelated Kits', async (t) => {
  const root = await fixture(t);
  await makeKit(root, 'zeta');
  await write(root, 'kits/zeta/src/index.mts', "export const stable = '@itharbors/kit-core';\n");
  await write(root, 'kits/broken/package.json', '{');

  const result = await auditKitArchitecture({ repositoryRoot: root, targetKit: 'zeta' });
  assert.deepEqual(result.errors, []);
  await assert.rejects(
    auditKitArchitecture({ repositoryRoot: root, targetKit: '../zeta' }),
    /invalid Kit slug/u,
  );
});

test('audits local dependency protocols in nested workspace manifests', async (t) => {
  const root = await fixture(t);
  await makeKit(root, 'alpha', { workspaces: ['packages/*'] });
  await write(root, 'kits/alpha/packages/good/package.json', JSON.stringify({
    name: '@fixture/good',
    dependencies: { '@fixture/shared': 'workspace:*', local: 'file:../shared' },
    devDependencies: { outside: 'link:../../../../packages/private' },
    optionalDependencies: { encoded: 'file:%2e%2e/%2e%2e/escape' },
    peerDependencies: { absolute: 'file:/tmp/private' },
  }));
  await write(root, 'kits/alpha/packages/shared/package.json', JSON.stringify({ name: '@fixture/shared' }));

  const result = await auditKitArchitecture({ repositoryRoot: root, targetKit: 'alpha' });
  assert.equal(result.errors.filter((error) => error.code === 'KIT_LOCAL_DEPENDENCY_ESCAPE').length, 3);
});

test('detects static Kit identities in common collection forms', async (t) => {
  const root = await fixture(t);
  await makeKit(root, 'alpha');
  await makeKit(root, 'zeta');
  await write(root, 'scripts/registries.mjs', [
    "export const kitSet = new Set([{ slug: 'alpha', label: 'Alpha' }]);",
    "export const productMap = new Map([['zeta', true]]);",
    "export const kitRegistry = { alpha: true };",
    "class Policy { supportedKits = ['alpha']; }",
    "config.kits = ['zeta'];",
  ].join('\n'));
  await write(root, 'scripts/general.test.mjs', "const SUPPORTED_KITS = ['alpha', 'zeta'];\n");
  const result = await auditKitArchitecture({ repositoryRoot: root });
  assert.equal(result.errors.filter((entry) => entry.code === 'STATIC_KIT_REGISTRY').length, 2);
});

test('parses multiline workflow and shell registries while ignoring comments', async (t) => {
  const root = await fixture(t);
  await makeKit(root, 'alpha');
  await makeKit(root, 'zeta');
  await write(root, '.github/workflows/ci.yml', [
    '# HARBORS_ZETA_TOKEN is documentation only',
    'matrix:',
    '  kits:',
    '    - alpha',
    '    - zeta',
  ].join('\n'));
  await write(root, 'scripts/release.sh', [
    '# HARBORS_ZETA_SECRET',
    'kit_slugs=(',
    '  alpha',
    '  zeta',
    ')',
  ].join('\n'));
  const result = await auditKitArchitecture({ repositoryRoot: root });
  assert.equal(result.errors.some((entry) => entry.code === 'FRAMEWORK_KIT_SPECIAL_CASE'), false);
  assert.equal(result.errors.filter((entry) => entry.code === 'STATIC_KIT_REGISTRY').length, 2);
});

test('rejects Kit tree symlinks without following them', async (t) => {
  const root = await fixture(t);
  await makeKit(root, 'alpha');
  await write(root, 'outside.ts', "import '../../zeta/private.js';\n");
  await symlink(path.join(root, 'outside.ts'), path.join(root, 'kits/alpha/src-link.ts'));
  const result = await auditKitArchitecture({ repositoryRoot: root, targetKit: 'alpha' });
  assert.deepEqual(result.errors.map((entry) => entry.code), ['KIT_LOCAL_DEPENDENCY_ESCAPE']);
});

test('repository tree satisfies the static architecture boundary', async () => {
  const repositoryRoot = path.resolve(new URL('../..', import.meta.url).pathname);
  const result = await auditKitArchitecture({ repositoryRoot });
  assert.deepEqual(result.errors, []);
});

test('CLI rejects extra arguments and emits one deterministic failure summary', async () => {
  let stdout = '';
  let stderr = '';
  const io = {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  };
  assert.equal(await runKitArchitectureCli(['alpha', 'extra'], io), 2);
  assert.match(stderr, /^Usage:/u);
  stdout = '';
  stderr = '';
  const code = await runKitArchitectureCli([], io, {
    repositoryRoot: '/repo',
    auditKitArchitecture: async () => ({
      scope: 'all',
      errors: [{ code: 'KIT_LOCK_MISSING', path: 'kits/zeta/package-lock.json', message: 'missing' }],
    }),
  });
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.equal(stderr.match(/KIT_ARCHITECTURE_BOUNDARY_FAILED/gu)?.length, 1);
  stdout = '';
  stderr = '';
  await runKitArchitectureCli([], io, {
    repositoryRoot: '/repo',
    auditKitArchitecture: async () => ({
      scope: 'all',
      errors: [{ code: 'KIT_LOCK_MISSING\nFAKE', path: '/tmp/private\npath', message: 'bad\nline' }],
    }),
  });
  assert.equal(stderr.trimEnd().split('\n').length, 2);
  assert.ok(stderr.trimEnd().split('\n').every((line) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(line)));
  assert.match(stderr, /\[invalid-path\]/u);
  assert.doesNotMatch(stderr, /\/tmp\/private/u);
});
