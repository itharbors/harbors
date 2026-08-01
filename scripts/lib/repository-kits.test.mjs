import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { discoverRepositoryKits, loadRepositoryKit } from './repository-kits.mjs';

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

async function createTempRepository() {
  const root = await mkdtemp(path.join(tmpdir(), 'repository-kits-'));
  await mkdir(path.join(root, 'kits'), { recursive: true });
  return root;
}

async function writeKit(root, slug, { kit, packageJson }) {
  const directory = path.join(root, 'kits', slug);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'kit.json'), JSON.stringify(kit, null, 2));
  await writeFile(path.join(directory, 'package.json'), JSON.stringify(packageJson, null, 2));
}

const baseKit = {
  schemaVersion: 1,
  id: '@example/kit-zeta',
  version: '0.1.0',
  channel: 'stable',
  publisher: 'example',
  requires: {
    harbors: '>=0.0.1 <0.1.0',
    kitApi: '^1.0.0',
    protocolVersion: 1,
  },
  target: { platform: 'any', arch: 'any' },
  permissions: [],
  entry: 'package.json',
};

const basePackageJson = {
  name: '@example/kit-zeta',
  version: '0.1.0',
  private: true,
  ceEditor: undefined,
  'ce-editor': {
    kit: {
      menuRoot: { id: 'zeta', label: 'Zeta' },
      layouts: { default: 'layout.json' },
      windowEntries: { main: 'main.html', secondary: 'secondary.html' },
      plugin: [],
    },
  },
  harbors: {
    distribution: 'market',
    ci: { runner: 'ubuntu-latest' },
    docs: { summary: 'Zeta fixture' },
    resources: [],
    storage: { legacyDataDirectories: [] },
    scripts: { build: 'build', test: 'test:kit', smoke: 'smoke' },
  },
};

test('discovers a temporary Kit without a static slug list', async () => {
  const root = await createTempRepository();
  try {
    await writeKit(root, 'zeta', { kit: baseKit, packageJson: basePackageJson });

    const kits = await discoverRepositoryKits({ repositoryRoot: root });
    assert.equal(kits.length, 1);
    const [kit] = kits;
    assert.deepEqual(
      {
        slug: kit.slug,
        id: kit.id,
        label: kit.label,
        distribution: kit.distribution,
        ciRunner: kit.ciRunner,
        summary: kit.summary,
      },
      {
        slug: 'zeta',
        id: '@example/kit-zeta',
        label: 'Zeta',
        distribution: 'market',
        ciRunner: 'ubuntu-latest',
        summary: 'Zeta fixture',
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a non-canonical slug before resolving a path', async () => {
  const root = await createTempRepository();
  try {
    await writeKit(root, 'zeta', { kit: baseKit, packageJson: basePackageJson });

    await assert.rejects(
      loadRepositoryKit({ repositoryRoot: root, slug: '../zeta' }),
      /canonical Kit slug/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a mismatched kit.json.id and package.json.name', async () => {
  const root = await createTempRepository();
  try {
    await writeKit(root, 'zeta', {
      kit: { ...baseKit, id: '@example/kit-other' },
      packageJson: basePackageJson,
    });

    await assert.rejects(
      discoverRepositoryKits({ repositoryRoot: root }),
      /identity mismatch/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects missing required scripts', async () => {
  const root = await createTempRepository();
  try {
    await writeKit(root, 'zeta', {
      kit: baseKit,
      packageJson: {
        ...basePackageJson,
        harbors: {
          ...basePackageJson.harbors,
          scripts: { build: 'build' },
        },
      },
    });

    await assert.rejects(
      discoverRepositoryKits({ repositoryRoot: root }),
      /harbors.scripts.test/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects an unsupported CI runner', async () => {
  const root = await createTempRepository();
  try {
    await writeKit(root, 'zeta', {
      kit: baseKit,
      packageJson: {
        ...basePackageJson,
        harbors: {
          ...basePackageJson.harbors,
          ci: { runner: 'windows-latest' },
        },
      },
    });

    await assert.rejects(
      discoverRepositoryKits({ repositoryRoot: root }),
      /harbors.ci.runner/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a duplicate real directory exposed through a symlink', async () => {
  const root = await createTempRepository();
  try {
    await writeKit(root, 'zeta', { kit: baseKit, packageJson: basePackageJson });
    await symlink(path.join(root, 'kits', 'zeta'), path.join(root, 'kits', 'zeta-copy'));

    await assert.rejects(
      discoverRepositoryKits({ repositoryRoot: root }),
      /duplicate Kit id/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a resource path that escapes the Kit root', async () => {
  const root = await createTempRepository();
  try {
    await writeKit(root, 'zeta', {
      kit: baseKit,
      packageJson: {
        ...basePackageJson,
        harbors: {
          ...basePackageJson.harbors,
          resources: ['../escape'],
        },
      },
    });

    await assert.rejects(
      discoverRepositoryKits({ repositoryRoot: root }),
      /harbors.resources\[0\] must be a normalized Kit-relative path/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('returns descriptors sorted by slug in lexical order', async () => {
  const root = await createTempRepository();
  try {
    await writeKit(root, 'beta', {
      kit: { ...baseKit, id: '@example/kit-beta' },
      packageJson: {
        ...basePackageJson,
        name: '@example/kit-beta',
        'ce-editor': {
          kit: {
            menuRoot: { id: 'beta', label: 'Beta' },
            layouts: { default: 'layout.json' },
            windowEntries: { main: 'main.html', secondary: 'secondary.html' },
            plugin: [],
          },
        },
      },
    });
    await writeKit(root, 'alpha', {
      kit: { ...baseKit, id: '@example/kit-alpha' },
      packageJson: {
        ...basePackageJson,
        name: '@example/kit-alpha',
        'ce-editor': {
          kit: {
            menuRoot: { id: 'alpha', label: 'Alpha' },
            layouts: { default: 'layout.json' },
            windowEntries: { main: 'main.html', secondary: 'secondary.html' },
            plugin: [],
          },
        },
      },
    });

    const kits = await discoverRepositoryKits({ repositoryRoot: root });
    assert.deepEqual(
      kits.map((kit) => kit.slug),
      ['alpha', 'beta'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('freezes returned descriptor records', async () => {
  const root = await createTempRepository();
  try {
    await writeKit(root, 'zeta', { kit: baseKit, packageJson: basePackageJson });

    const [kit] = await discoverRepositoryKits({ repositoryRoot: root });
    assert.equal(Object.isFrozen(kit), true);
    assert.equal(Object.isFrozen(kit.scripts), true);
    assert.equal(Object.isFrozen(kit.resources), true);
    assert.equal(Object.isFrozen(kit.legacyDataDirectories), true);
    assert.equal(Object.isFrozen(kit.permissions), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('deep-freezes nested manifest and packageJson records', async () => {
  const root = await createTempRepository();
  try {
    await writeKit(root, 'zeta', { kit: baseKit, packageJson: basePackageJson });

    const [kit] = await discoverRepositoryKits({ repositoryRoot: root });

    assert.equal(Object.isFrozen(kit.manifest), true);
    assert.equal(Object.isFrozen(kit.manifest.requires), true);
    assert.equal(Object.isFrozen(kit.manifest.target), true);
    assert.equal(Object.isFrozen(kit.manifest.permissions), true);

    assert.equal(Object.isFrozen(kit.packageJson), true);
    assert.equal(Object.isFrozen(kit.packageJson['ce-editor']), true);
    assert.equal(Object.isFrozen(kit.packageJson['ce-editor'].kit), true);
    assert.equal(Object.isFrozen(kit.packageJson['ce-editor'].kit.menuRoot), true);
    assert.equal(Object.isFrozen(kit.packageJson.harbors), true);
    assert.equal(Object.isFrozen(kit.packageJson.harbors.ci), true);
    assert.equal(Object.isFrozen(kit.packageJson.harbors.docs), true);
    assert.equal(Object.isFrozen(kit.packageJson.harbors.scripts), true);
    assert.equal(Object.isFrozen(kit.packageJson.harbors.resources), true);
    assert.equal(Object.isFrozen(kit.packageJson.harbors.storage), true);
    assert.equal(
      Object.isFrozen(kit.packageJson.harbors.storage.legacyDataDirectories),
      true,
    );

    assert.throws(() => {
      kit.manifest.requires.harbors = '>=9.9.9';
    }, /assign to read only property/u);
    assert.throws(() => {
      kit.manifest.target.platform = 'win32';
    }, /assign to read only property/u);
    assert.throws(() => {
      kit.manifest.permissions.push('network');
    }, /add property/u);
    assert.throws(() => {
      kit.packageJson.harbors.ci.runner = 'macos-14';
    }, /assign to read only property/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a declared resource that does not exist', async () => {
  const root = await createTempRepository();
  try {
    await writeKit(root, 'zeta', {
      kit: baseKit,
      packageJson: {
        ...basePackageJson,
        harbors: {
          ...basePackageJson.harbors,
          resources: ['missing/file.txt'],
        },
      },
    });

    await assert.rejects(
      discoverRepositoryKits({ repositoryRoot: root }),
      /harbors.resources\[0\] does not exist/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a declared resource whose final entry is a symlink inside the Kit root', async () => {
  const root = await createTempRepository();
  try {
    const kitDir = path.join(root, 'kits', 'zeta');
    await writeKit(root, 'zeta', {
      kit: baseKit,
      packageJson: {
        ...basePackageJson,
        harbors: {
          ...basePackageJson.harbors,
          resources: ['linked'],
        },
      },
    });
    await writeFile(path.join(kitDir, 'real.txt'), 'real');
    await symlink(path.join(kitDir, 'real.txt'), path.join(kitDir, 'linked'));

    await assert.rejects(
      discoverRepositoryKits({ repositoryRoot: root }),
      /harbors.resources\[0\] must not be a symlink/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a declared resource whose final entry is a symlink outside the Kit root', async () => {
  const root = await createTempRepository();
  try {
    const kitDir = path.join(root, 'kits', 'zeta');
    await writeKit(root, 'zeta', {
      kit: baseKit,
      packageJson: {
        ...basePackageJson,
        harbors: {
          ...basePackageJson.harbors,
          resources: ['escape'],
        },
      },
    });
    await symlink(path.join(root, 'outside'), path.join(kitDir, 'escape'));

    await assert.rejects(
      discoverRepositoryKits({ repositoryRoot: root }),
      /harbors.resources\[0\] must not be a symlink/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a declared resource with an intermediate symlink component', async () => {
  const root = await createTempRepository();
  try {
    const kitDir = path.join(root, 'kits', 'zeta');
    await writeKit(root, 'zeta', {
      kit: baseKit,
      packageJson: {
        ...basePackageJson,
        harbors: {
          ...basePackageJson.harbors,
          resources: ['linked/sub/file.txt'],
        },
      },
    });
    await mkdir(path.join(kitDir, 'real'), { recursive: true });
    await writeFile(path.join(kitDir, 'real', 'file.txt'), 'real');
    await symlink(path.join(kitDir, 'real'), path.join(kitDir, 'linked'));

    await assert.rejects(
      discoverRepositoryKits({ repositoryRoot: root }),
      /harbors.resources\[0\] must not be a symlink/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('accepts declared resources that are regular files or directories', async () => {
  const root = await createTempRepository();
  try {
    const kitDir = path.join(root, 'kits', 'zeta');
    await writeKit(root, 'zeta', {
      kit: baseKit,
      packageJson: {
        ...basePackageJson,
        harbors: {
          ...basePackageJson.harbors,
          resources: ['plugins/demo', 'resources/icon.png'],
        },
      },
    });
    await mkdir(path.join(kitDir, 'plugins', 'demo'), { recursive: true });
    await mkdir(path.join(kitDir, 'resources'), { recursive: true });
    await writeFile(path.join(kitDir, 'resources', 'icon.png'), 'png');

    const [kit] = await discoverRepositoryKits({ repositoryRoot: root });
    assert.deepEqual(kit.resources, ['plugins/demo', 'resources/icon.png']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('discovers every current repository Kit with matching identity', async () => {
  const kits = await discoverRepositoryKits({ repositoryRoot });
  assert.ok(kits.length >= 1);
  for (const kit of kits) {
    assert.equal(kit.packageJson.name, kit.id);
    assert.equal(kit.packageJson.version, kit.version);
    assert.equal(kit.manifest.id, kit.id);
    assert.equal(kit.manifest.version, kit.version);
  }
});
