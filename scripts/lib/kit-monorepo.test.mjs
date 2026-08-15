import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadOfficialKit, loadTrustedMarketKit } from './kit-monorepo.mjs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

async function createKitRepository() {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-monorepo-'));
  await cp(path.join(repositoryRoot, 'kits', 'default'), path.join(root, 'kits', 'default'), {
    recursive: true,
  });
  return root;
}

async function updateJson(file, transform) {
  const value = JSON.parse(await readFile(file, 'utf8'));
  transform(value);
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function updateYaml(file, transform) {
  const value = parseYaml(await readFile(file, 'utf8'));
  transform(value);
  await writeFile(file, `${stringifyYaml(value)}\n`);
}

test('discovers a Kit descriptor directly from its kits directory', async () => {
  const root = await createKitRepository();
  try {
    const kit = await loadTrustedMarketKit({ repositoryRoot: root, slug: 'default' });
    assert.equal(kit.directory, await realpath(path.join(root, 'kits', 'default')));
    assert.equal(kit.slug, 'default');
    assert.equal(kit.id, 'default');
    assert.equal(kit.version, '0.0.1');
    assert.equal(kit.packageJson.name, kit.manifest.id);
    assert.ok(Object.isFrozen(kit));
    assert.ok(Object.isFrozen(kit.manifest));
    assert.ok(Object.isFrozen(kit.packageJson));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('accepts only canonical Kit slugs', async () => {
  for (const slug of [
    '', 'Default', 'default-', '-default', 'default--next', '../default',
    'default/child', 'default\\child', '.', '..', null,
  ]) {
    await assert.rejects(
      loadTrustedMarketKit({ repositoryRoot, slug }),
      /invalid canonical Kit slug/i,
      String(slug),
    );
  }
});

test('rejects unknown Kit directories and path traversal attempts', async () => {
  await assert.rejects(
    loadTrustedMarketKit({ repositoryRoot, slug: 'does-not-exist' }),
    /unknown Kit slug/i,
  );
  await assert.rejects(
    loadTrustedMarketKit({ repositoryRoot, slug: '../default' }),
    /invalid canonical Kit slug/i,
  );
});

test('rejects a symbolic-link Kit directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-monorepo-link-'));
  try {
    await cp(path.join(repositoryRoot, 'kits', 'default'), path.join(root, 'source'), {
      recursive: true,
    });
    await mkdir(path.join(root, 'kits'), { recursive: true });
    await symlink(path.join(root, 'source'), path.join(root, 'kits', 'default'));
    await assert.rejects(
      loadTrustedMarketKit({ repositoryRoot: root, slug: 'default' }),
      /not a real directory/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('requires kit.json and package.json to have the same identity and version', async () => {
  const root = await createKitRepository();
  try {
    const packageJson = path.join(root, 'kits', 'default', 'package.json');
    await updateJson(packageJson, (value) => { value.name = 'other-kit'; });
    await assert.rejects(
      loadTrustedMarketKit({ repositoryRoot: root, slug: 'default' }),
      /Kit identity mismatch/i,
    );

    await updateJson(packageJson, (value) => {
      value.name = 'default';
      value.version = '9.9.9';
    });
    await assert.rejects(
      loadTrustedMarketKit({ repositoryRoot: root, slug: 'default' }),
      /Kit version mismatch/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('requires pnpm-lock.yaml to match the Kit descriptor identity', async () => {
  const root = await createKitRepository();
  try {
    await updateYaml(path.join(root, 'kits', 'default', 'pnpm-lock.yaml'), (value) => {
      value.importers['.'].name = 'other-kit';
      value.importers['.'].version = '9.9.9';
    });
    await assert.rejects(
      loadTrustedMarketKit({ repositoryRoot: root, slug: 'default' }),
      /pnpm-lock identity mismatch/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loadOfficialKit projects the descriptor CI runner as runner', async () => {
  const descriptor = await loadTrustedMarketKit({ repositoryRoot, slug: 'default' });
  const kit = await loadOfficialKit({ repositoryRoot, slug: 'default' });

  assert.deepEqual(kit, { ...descriptor, runner: descriptor.ciRunner });
  assert.equal(kit.runner, 'ubuntu-latest');
});
