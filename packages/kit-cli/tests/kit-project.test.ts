import { mkdtemp, cp, readFile, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { validateKit } from '../src/index.js';

const fixtureDirectory = path.resolve(import.meta.dirname, 'fixtures/minimal-kit');
const temporaryDirectories: string[] = [];

async function copyFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-kit-project-'));
  temporaryDirectories.push(root);
  const directory = path.join(root, 'kit');
  await cp(fixtureDirectory, directory, { recursive: true });
  return directory;
}

async function updateJson(
  file: string,
  update: (value: Record<string, any>) => void,
): Promise<void> {
  const value = JSON.parse(await readFile(file, 'utf8')) as Record<string, any>;
  update(value);
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('validateKit', () => {
  it('returns only the runtime files needed to publish a valid Kit', async () => {
    const project = await validateKit(fixtureDirectory);

    expect(project.manifest.id).toBe('@example/kit-demo');
    expect(project.packageNames).toEqual(['@example/demo', '@example/kit-demo']);
    expect(project.payload.map((file) => file.archivePath)).toEqual([
      'kit.json',
      'layout.json',
      'main.html',
      'package.json',
      'plugins/demo/main/dist/index.js',
      'plugins/demo/package.json',
      'plugins/demo/panel.main/dist/index.html',
      'secondary.html',
    ]);
  });

  it.each([
    ['name', '@example/kit-other'],
    ['version', '1.2.4'],
  ])('rejects a runtime package with mismatched %s', async (field, value) => {
    const directory = await copyFixture();
    await updateJson(path.join(directory, 'package.json'), (pkg) => {
      pkg[field] = value;
    });

    await expect(validateKit(directory)).rejects.toThrow(new RegExp(field, 'i'));
  });

  it('rejects a missing Kit shell file', async () => {
    const directory = await copyFixture();
    await rm(path.join(directory, 'secondary.html'));

    await expect(validateKit(directory)).rejects.toThrow(/windowEntries\.secondary/i);
  });

  it('rejects a source-only plugin main entry', async () => {
    const directory = await copyFixture();
    const pluginDirectory = path.join(directory, 'plugins/demo');
    await mkdir(path.join(pluginDirectory, 'main/src'), { recursive: true });
    await writeFile(path.join(pluginDirectory, 'main/src/index.ts'), 'export default {};\n');
    await updateJson(path.join(pluginDirectory, 'package.json'), (pkg) => {
      pkg.main = './main/src/index.ts';
    });

    await expect(validateKit(directory)).rejects.toThrow(/dist JavaScript entry/i);
  });

  it('rejects an undeclared plugin directory', async () => {
    const directory = await copyFixture();
    const extraDirectory = path.join(directory, 'plugins/extra');
    await mkdir(extraDirectory, { recursive: true });
    await writeFile(path.join(extraDirectory, 'package.json'), JSON.stringify({
      name: '@example/extra',
      main: './main/dist/index.js',
      'ce-editor': {},
    }));

    await expect(validateKit(directory)).rejects.toThrow(/undeclared plugin/i);
  });

  it('rejects duplicate plugin package names', async () => {
    const directory = await copyFixture();
    const duplicateDirectory = path.join(directory, 'plugins/duplicate');
    await cp(path.join(directory, 'plugins/demo'), duplicateDirectory, { recursive: true });

    await expect(validateKit(directory)).rejects.toThrow(/duplicate plugin package name/i);
  });

  it('rejects plugin manifests nested below plugins/*', async () => {
    const directory = await copyFixture();
    const nestedDirectory = path.join(directory, 'plugins/group/nested');
    await mkdir(nestedDirectory, { recursive: true });
    await writeFile(path.join(nestedDirectory, 'package.json'), JSON.stringify({
      name: '@example/nested',
    }));

    await expect(validateKit(directory)).rejects.toThrow(/one-level plugins/i);
  });

  it('rejects a declared public asset root outside its plugin directory', async () => {
    const directory = await copyFixture();
    await updateJson(path.join(directory, 'plugins/demo/package.json'), (pkg) => {
      pkg['ce-editor'].assets = { public: ['../../outside'] };
    });

    await expect(validateKit(directory)).rejects.toThrow(/public asset.*inside/i);
  });

  it('does not leak unselected source or test directories into the payload', async () => {
    const directory = await copyFixture();
    await mkdir(path.join(directory, 'plugins/demo/main/src'), { recursive: true });
    await mkdir(path.join(directory, 'plugins/demo/tests'), { recursive: true });
    await writeFile(path.join(directory, 'plugins/demo/main/src/index.ts'), 'secret source\n');
    await writeFile(path.join(directory, 'plugins/demo/tests/main.test.ts'), 'secret test\n');

    const project = await validateKit(directory);

    expect(project.payload.map((file) => file.archivePath)).not.toEqual(
      expect.arrayContaining([
        'plugins/demo/main/src/index.ts',
        'plugins/demo/tests/main.test.ts',
      ]),
    );
  });

  it('rejects a symbolic link anywhere in the selected payload', async () => {
    const directory = await copyFixture();
    const pluginDirectory = path.join(directory, 'plugins/demo');
    await mkdir(path.join(pluginDirectory, 'assets'), { recursive: true });
    await writeFile(path.join(pluginDirectory, 'assets/icon.svg'), '<svg/>\n');
    await symlink('icon.svg', path.join(pluginDirectory, 'assets/linked.svg'));
    await updateJson(path.join(pluginDirectory, 'package.json'), (pkg) => {
      pkg['ce-editor'].assets = { public: ['./assets'] };
    });

    await expect(validateKit(directory)).rejects.toThrow(/symbolic link/i);
  });

  it('materializes only the production dependency closure and workspace dist', async () => {
    const directory = await copyFixture();
    await updateJson(path.join(directory, 'package.json'), (pkg) => {
      pkg.dependencies = { 'runtime-root': '1.0.0' };
      pkg.devDependencies = { 'dev-only': '1.0.0' };
    });
    await updateJson(path.join(directory, 'plugins/demo/package.json'), (pkg) => {
      pkg.dependencies = { '@example/contracts': '1.0.0' };
    });

    const contracts = path.join(directory, 'packages/contracts');
    await mkdir(path.join(contracts, 'dist'), { recursive: true });
    await mkdir(path.join(contracts, 'src'), { recursive: true });
    await writeFile(path.join(contracts, 'package.json'), JSON.stringify({
      name: '@example/contracts',
      version: '1.0.0',
      dependencies: { transitive: '2.0.0' },
    }));
    await writeFile(path.join(contracts, 'dist/index.js'), 'export const contract = true;\n');
    await writeFile(path.join(contracts, 'src/index.ts'), 'secret source\n');

    const modules = path.join(directory, 'node_modules');
    await mkdir(path.join(modules, '@example'), { recursive: true });
    await symlink(contracts, path.join(modules, '@example/contracts'), 'dir');
    await writeInstalledPackage(modules, 'runtime-root', '1.0.0', {
      dependencies: { transitive: '2.0.0' },
    });
    await writeInstalledPackage(modules, 'transitive', '2.0.0');
    await writeInstalledPackage(modules, 'dev-only', '1.0.0');
    await mkdir(path.join(modules, '.bin'), { recursive: true });
    await symlink('../runtime-root/index.js', path.join(modules, '.bin/runtime-root'));

    const project = await validateKit(directory);
    const payload = project.payload.map((file) => file.archivePath);
    expect(payload).toEqual(expect.arrayContaining([
      'node_modules/@example/contracts/package.json',
      'node_modules/@example/contracts/dist/index.js',
      'node_modules/runtime-root/package.json',
      'node_modules/runtime-root/index.js',
      'node_modules/transitive/package.json',
      'node_modules/transitive/index.js',
    ]));
    expect(payload).not.toEqual(expect.arrayContaining([
      'node_modules/.bin/runtime-root',
      'node_modules/@example/contracts/src/index.ts',
      'node_modules/dev-only/package.json',
    ]));
    expect(project.packageNames).toEqual([
      '@example/contracts',
      '@example/demo',
      '@example/kit-demo',
      'runtime-root',
      'transitive',
    ]);
  });

  it('resolves hoisted production dependencies from a matching workspace lock root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-kit-workspace-'));
    temporaryDirectories.push(root);
    const directory = path.join(root, 'kits/demo');
    await cp(fixtureDirectory, directory, { recursive: true });
    await updateJson(path.join(directory, 'package.json'), (pkg) => {
      pkg.dependencies = { 'runtime-root': '1.0.0' };
    });
    await updateJson(path.join(directory, 'plugins/demo/package.json'), (pkg) => {
      pkg.dependencies = { '@example/contracts': '1.0.0' };
    });
    await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'workspace-root' },
        'kits/demo': { name: '@example/kit-demo', version: '1.2.3' },
        'node_modules/@example/contracts': { link: true, resolved: 'packages/contracts' },
      },
    }));

    const contracts = path.join(root, 'packages/contracts');
    await mkdir(path.join(contracts, 'dist'), { recursive: true });
    await writeFile(path.join(contracts, 'package.json'), JSON.stringify({
      name: '@example/contracts',
      version: '1.0.0',
      dependencies: { transitive: '2.0.0' },
    }));
    await writeFile(path.join(contracts, 'dist/index.js'), 'export const contract = true;\n');
    await mkdir(path.join(contracts, 'src'), { recursive: true });
    await writeFile(path.join(contracts, 'src/index.ts'), 'secret source\n');

    const modules = path.join(root, 'node_modules');
    await mkdir(path.join(modules, '@example'), { recursive: true });
    await symlink(contracts, path.join(modules, '@example/contracts'), 'dir');
    await writeInstalledPackage(modules, 'runtime-root', '1.0.0', {
      dependencies: { transitive: '2.0.0' },
    });
    await writeInstalledPackage(modules, 'transitive', '2.0.0');

    const project = await validateKit(directory);

    expect(project.payload.map((file) => file.archivePath)).toEqual(expect.arrayContaining([
      'node_modules/@example/contracts/package.json',
      'node_modules/@example/contracts/dist/index.js',
      'node_modules/runtime-root/package.json',
      'node_modules/runtime-root/index.js',
      'node_modules/transitive/package.json',
      'node_modules/transitive/index.js',
    ]));
    expect(project.payload.map((file) => file.archivePath)).not.toEqual(expect.arrayContaining([
      'node_modules/@example/contracts/src/index.ts',
    ]));
  });

  it('treats a symlink without a workspace lock entry as a normal dependency', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-kit-local-link-'));
    temporaryDirectories.push(root);
    const directory = path.join(root, 'kits/demo');
    await cp(fixtureDirectory, directory, { recursive: true });
    await updateJson(path.join(directory, 'package.json'), (pkg) => {
      pkg.dependencies = { 'local-linked': '1.0.0' };
    });
    await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'workspace-root' },
        'kits/demo': { name: '@example/kit-demo', version: '1.2.3' },
      },
    }));
    const localLinked = path.join(root, 'local-linked-source');
    await mkdir(localLinked, { recursive: true });
    await writeFile(path.join(localLinked, 'package.json'), JSON.stringify({
      name: 'local-linked',
      version: '1.0.0',
    }));
    await writeFile(path.join(localLinked, 'index.js'), 'export const local = true;\n');
    await mkdir(path.join(root, 'node_modules'), { recursive: true });
    await symlink(localLinked, path.join(root, 'node_modules/local-linked'), 'dir');

    const project = await validateKit(directory);

    expect(project.payload.map((file) => file.archivePath)).toEqual(expect.arrayContaining([
      'node_modules/local-linked/package.json',
      'node_modules/local-linked/index.js',
    ]));
  });

  it('does not use ancestor node_modules when its lock entry does not match the Kit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-kit-mismatched-lock-'));
    temporaryDirectories.push(root);
    const directory = path.join(root, 'kits/demo');
    await cp(fixtureDirectory, directory, { recursive: true });
    await updateJson(path.join(directory, 'package.json'), (pkg) => {
      pkg.dependencies = { 'runtime-root': '1.0.0' };
    });
    await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'kits/demo': { name: '@example/kit-other', version: '1.2.3' },
      },
    }));
    await writeInstalledPackage(path.join(root, 'node_modules'), 'runtime-root', '1.0.0');

    await expect(validateKit(directory)).rejects.toThrow(/production dependency runtime-root.*not installed/i);
  });

  it('rejects a matching workspace dependency symlink that resolves outside its installation root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-kit-outside-link-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'harbors-kit-outside-target-'));
    temporaryDirectories.push(root, outside);
    const directory = path.join(root, 'kits/demo');
    await cp(fixtureDirectory, directory, { recursive: true });
    await updateJson(path.join(directory, 'package.json'), (pkg) => {
      pkg.dependencies = { outside: '1.0.0' };
    });
    await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'kits/demo': { name: '@example/kit-demo', version: '1.2.3' },
        'node_modules/outside': { link: true, resolved: path.join(outside, 'outside') },
      },
    }));
    await writeInstalledPackage(outside, 'outside', '1.0.0');
    await mkdir(path.join(root, 'node_modules'), { recursive: true });
    await symlink(path.join(outside, 'outside'), path.join(root, 'node_modules/outside'), 'dir');

    await expect(validateKit(directory)).rejects.toThrow(/production dependency outside must stay inside/i);
  });

  it('rejects a missing production dependency', async () => {
    const directory = await copyFixture();
    await updateJson(path.join(directory, 'plugins/demo/package.json'), (pkg) => {
      pkg.dependencies = { missing: '1.0.0' };
    });

    await expect(validateKit(directory)).rejects.toThrow(/production dependency missing.*not installed/i);
  });
});

async function writeInstalledPackage(
  modules: string,
  name: string,
  version: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const directory = path.join(modules, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, version, ...extra }));
  await writeFile(path.join(directory, 'index.js'), `export default ${JSON.stringify(name)};\n`);
}
