import { afterEach, describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KitModule, normalizeKitLayoutConfig } from '../../src/framework/kit/index';
import type { KitDescriptor } from '../../src/framework/kit/types';
import { createEditor } from '../../src/editor/index';
import { CredentialStore } from '../../src/credentials/store';
import { CredentialVault } from '../../src/credentials/vault';
import { testAssembly } from '../helpers/assembly';
import type { PluginCredentialVault } from '@itharbors/plugin-types';
import { createTestPluginPathRoots } from '../helpers/plugin-paths';

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function createCredentialKit(
  root: string,
  directory: string,
  id: string,
  permissions: unknown,
  options: { manifestId?: string; manifestVersion?: string } = {},
): string {
  const kitDir = path.join(root, directory);
  const pluginsDir = path.join(kitDir, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  writeJson(path.join(kitDir, 'package.json'), {
    name: id,
    version: '1.0.0',
    'ce-editor': {
      kit: {
        layouts: { default: 'layout.json' },
        plugin: ['@scope/mysql-core', '@scope/mysql-explorer'],
        windowEntries: { main: 'main.html', secondary: 'secondary.html' },
      },
    },
  });
  writeJson(path.join(kitDir, 'kit.json'), {
    schemaVersion: 1,
    id: options.manifestId ?? id,
    version: options.manifestVersion ?? '1.0.0',
    channel: 'stable',
    publisher: 'scope',
    requires: { harbors: '*', kitApi: '*', protocolVersion: 1 },
    target: { platform: 'any', arch: 'any' },
    permissions,
    entry: 'package.json',
  });
  writeJson(path.join(kitDir, 'layout.json'), { windows: [] });
  fs.writeFileSync(path.join(kitDir, 'main.html'), '<html></html>');
  fs.writeFileSync(path.join(kitDir, 'secondary.html'), '<html></html>');

  for (const [dirName, name, capabilities] of [
    ['mysql-core', '@scope/mysql-core', ['credentials']],
    ['mysql-explorer', '@scope/mysql-explorer', undefined],
  ] as const) {
    const pluginDir = path.join(pluginsDir, dirName);
    fs.mkdirSync(path.join(pluginDir, 'main', 'dist'), { recursive: true });
    writeJson(path.join(pluginDir, 'package.json'), {
      name,
      type: 'module',
      main: './main/dist/index.js',
      'ce-editor': capabilities ? { capabilities } : {},
    });
    fs.writeFileSync(path.join(pluginDir, 'main', 'dist', 'index.js'), `
      let credentials;
      editor.plugin.define({
        lifecycle: { load(runtime) { credentials = runtime.credentials; } },
        methods: {
          hasCredentials() { return credentials !== undefined; },
          put(input) { return credentials.put(input); },
          get(id) { return credentials.get(id); },
        },
      });
    `);
  }

  return kitDir;
}

function assemblyFor(kitDir: string) {
  return {
    ...testAssembly,
    defaultKit: JSON.parse(fs.readFileSync(path.join(kitDir, 'package.json'), 'utf8')).name as string,
    kitSources: [{ directory: kitDir, source: 'explicit' as const }],
  };
}

function assemblyForKits(...kitDirs: string[]) {
  return {
    ...assemblyFor(kitDirs[0]),
    kitSources: kitDirs.map((directory) => ({ directory, source: 'explicit' as const })),
  };
}

function instrumentCredentialPlugin(kitDir: string, marker: string, failLoad = false): void {
  fs.writeFileSync(path.join(kitDir, 'plugins', 'mysql-core', 'main', 'dist', 'index.js'), `
    let credentials;
    editor.plugin.define({
      lifecycle: {
        load(runtime) {
          credentials = runtime.credentials;
          globalThis.__credentialLeaseEvents.push({ marker: ${JSON.stringify(marker)}, credentials });
          ${failLoad ? "throw new Error('credential plugin load failed');" : ''}
        },
      },
      methods: {
        put(input) { return credentials.put(input); },
        get(id) { return credentials.get(id); },
      },
    });
  `);
}

describe('KitModule', () => {
  let kitModule: KitModule;
  const temporaryRoots: string[] = [];
  const kit: KitDescriptor = {
    name: 'default-kit',
    label: 'Default',
    menuRoot: { id: 'default', label: 'Default' },
    plugins: ['p'],
    layouts: {
      default: { windows: [] },
    },
    windowEntries: {
      main: 'main.html',
      secondary: 'secondary.html',
    },
  };

  beforeEach(() => {
    kitModule = new KitModule();
  });

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    delete (globalThis as typeof globalThis & { __credentialLeaseEvents?: unknown }).__credentialLeaseEvents;
  });

  it('register stores and returns a kit', () => {
    expect(kitModule.register(kit).name).toBe('default-kit');
    expect(kitModule.get('default-kit')).toEqual(kit);
  });

  it('list returns all registered kits', () => {
    kitModule.register(kit);
    kitModule.register({ ...kit, name: 'second-kit' });
    expect(kitModule.list()).toHaveLength(2);
  });

  it('switchKit sets the active kit', () => {
    kitModule.register(kit);
    kitModule.switchKit('default-kit');
    expect(kitModule.getCurrent()?.name).toBe('default-kit');
  });

  it('switchKit throws for unknown kit', () => {
    expect(() => kitModule.switchKit('missing')).toThrow(/not found/);
  });

  it('unregister clears active kit', () => {
    kitModule.register(kit);
    kitModule.switchKit('default-kit');
    kitModule.unregister('default-kit');
    expect(kitModule.getCurrent()).toBeUndefined();
  });

  it('normalizes legacy layout windows into runtime window descriptors', () => {
    const layout = normalizeKitLayoutConfig({
      windows: [
        {
          id: 'main',
          type: 'sidebar',
          title: 'Legacy title',
          layout: { type: 'leaf', panel: 'demo.panel' },
        },
      ],
      activePanel: 'demo.panel',
    }, {
      main: 'main.html',
      secondary: 'secondary.html',
    });

    expect(layout).toEqual({
      windows: [
        {
          id: 'main',
          kind: 'main',
          type: 'panel-area',
          entry: 'main.html',
          state: 'open',
          layout: { type: 'leaf', panel: 'demo.panel' },
          panelInstanceIds: [],
        },
      ],
      activePanel: 'demo.panel',
    });
  });

  it('getLayout returns the named layout from the active kit', () => {
    const kitWithLayouts: KitDescriptor = {
      name: 'multi-layout-kit',
      menuRoot: { id: 'multi-layout', label: 'Multi Layout' },
      plugins: [],
      layouts: {
        default: { windows: [] },
        debug: { windows: [{ id: 'dbg', kind: 'main', type: 'panel-area', entry: 'main.html', state: 'open', layout: { type: 'leaf', panel: 'debug' }, panelInstanceIds: [] }] },
      },
      windowEntries: { main: 'main.html', secondary: 'secondary.html' },
    };
    kitModule.register(kitWithLayouts);
    kitModule.switchKit('multi-layout-kit');

    expect(kitModule.getLayout('default')).toEqual({ windows: [] });
    expect(kitModule.getLayout('debug')).toEqual(kitWithLayouts.layouts.debug);
    expect(kitModule.getLayout('nonexistent')).toBeUndefined();
  });

  it('listLayouts returns all layout names from the active kit', () => {
    const kitWithLayouts: KitDescriptor = {
      name: 'multi-layout-kit',
      menuRoot: { id: 'multi-layout', label: 'Multi Layout' },
      plugins: [],
      layouts: {
        default: { windows: [] },
        debug: { windows: [] },
        zen: { windows: [] },
      },
      windowEntries: { main: 'main.html', secondary: 'secondary.html' },
    };
    kitModule.register(kitWithLayouts);
    kitModule.switchKit('multi-layout-kit');

    expect(kitModule.listLayouts()).toEqual(['default', 'debug', 'zen']);
  });

  it('getLayout returns undefined when no kit is active', () => {
    expect(kitModule.getLayout('default')).toBeUndefined();
  });

  it('listLayouts returns empty array when no kit is active', () => {
    expect(kitModule.listLayouts()).toEqual([]);
  });

  it('copies adjacent Kit permissions and requires package identity to match kit.json', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-credential-manifest-'));
    temporaryRoots.push(root);
    const validKit = createCredentialKit(root, 'valid', '@scope/kit-valid', ['network', 'credentials']);
    const idMismatch = createCredentialKit(root, 'id-mismatch', '@scope/kit-id', ['credentials'], {
      manifestId: '@scope/kit-other',
    });
    const versionMismatch = createCredentialKit(root, 'version-mismatch', '@scope/kit-version', ['credentials'], {
      manifestVersion: '2.0.0',
    });

    const validEditor = createEditor('valid-manifest', {
      assembly: assemblyFor(validKit), pluginPathRoots: createTestPluginPathRoots(),
    });
    const idEditor = createEditor('id-mismatch', {
      assembly: assemblyFor(idMismatch), pluginPathRoots: createTestPluginPathRoots(),
    });
    const versionEditor = createEditor('version-mismatch', {
      assembly: assemblyFor(versionMismatch), pluginPathRoots: createTestPluginPathRoots(),
    });

    await expect(validEditor.kit.load()).resolves.toMatchObject({
      name: '@scope/kit-valid',
      permissions: ['network', 'credentials'],
    });
    await expect(idEditor.kit.load()).rejects.toThrow(/kit\.json.*id|identity/i);
    await expect(versionEditor.kit.load()).rejects.toThrow(/kit\.json.*version|identity/i);
    await Promise.all([validEditor.dispose(), idEditor.dispose(), versionEditor.dispose()]);
  });

  it.each([
    ['unknown', ['secrets']],
    ['duplicate', ['credentials', 'credentials']],
    ['non-array', 'credentials'],
  ])('rejects %s Kit permissions before loading external plugins', async (_label, permissions) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-invalid-permissions-'));
    temporaryRoots.push(root);
    const kitDir = createCredentialKit(root, 'invalid', '@scope/kit-invalid', permissions);
    const editor = createEditor('invalid-permissions', {
      assembly: assemblyFor(kitDir), pluginPathRoots: createTestPluginPathRoots(),
    });

    await expect(editor.kit.load()).rejects.toThrow(/permission/i);
    expect(editor.plugin.listLoaded()).not.toContain('@scope/mysql-core');
    await editor.dispose();
  });

  it('injects credentials only when mode, Kit permission, plugin capability, and owner scope all pass', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-credential-gates-'));
    temporaryRoots.push(root);
    const ownerKit = createCredentialKit(root, 'owner', '@scope/kit-owner', ['credentials']);
    const noPermissionKit = createCredentialKit(root, 'no-permission', '@scope/kit-no-permission', []);
    const otherKit = createCredentialKit(root, 'other', '@scope/kit-other', ['credentials']);
    const databasePath = path.join(root, 'credentials.sqlite');
    const secrets = new Map<string, string>();
    const vault = new CredentialVault({
      mode: 'local',
      store: new CredentialStore(databasePath),
      keyring: {
        get: async (account) => secrets.get(account) ?? null,
        set: async (account, secret) => { secrets.set(account, secret); },
        delete: async (account) => { secrets.delete(account); },
      },
    });
    const offVault = new CredentialVault({ mode: 'off' });
    const multiUserVault = new CredentialVault({ mode: 'multi-user' });
    const createVaultEditor = (sessionId: string, kitDir: string, credentialVault: CredentialVault) => (
      createEditor(sessionId, {
        assembly: assemblyFor(kitDir),
        pluginPathRoots: createTestPluginPathRoots(),
        credentialVault,
      })
    );
    const owner = createVaultEditor('owner', ownerKit, vault);
    const noPermission = createVaultEditor('no-permission', noPermissionKit, vault);
    const otherOwner = createVaultEditor('other-owner', otherKit, vault);
    const offMode = createVaultEditor('off-mode', ownerKit, offVault);
    const multiUserMode = createVaultEditor('multi-user-mode', ownerKit, multiUserVault);

    await Promise.all([
      owner.kit.load(),
      noPermission.kit.load(),
      otherOwner.kit.load(),
      offMode.kit.load(),
      multiUserMode.kit.load(),
    ]);
    const ownerProfile = await owner.plugin.callPlugin('@scope/mysql-core', 'put', {
      label: 'Owner database',
      metadata: { host: 'localhost' },
      secret: 'owner-secret',
    }) as { id: string };

    expect(owner.plugin.callPlugin('@scope/mysql-core', 'hasCredentials')).toBe(true);
    expect(owner.plugin.callPlugin('@scope/mysql-explorer', 'hasCredentials')).toBe(false);
    expect((owner as unknown as { credentials?: unknown }).credentials).toBeUndefined();
    expect(noPermission.plugin.callPlugin('@scope/mysql-core', 'hasCredentials')).toBe(false);
    expect(offMode.plugin.callPlugin('@scope/mysql-core', 'hasCredentials')).toBe(false);
    expect(multiUserMode.plugin.callPlugin('@scope/mysql-core', 'hasCredentials')).toBe(false);
    await expect(otherOwner.plugin.callPlugin('@scope/mysql-core', 'get', ownerProfile.id))
      .rejects.toMatchObject({ code: 'CREDENTIAL_PROFILE_NOT_FOUND' });

    await Promise.all([owner.dispose(), noPermission.dispose(), otherOwner.dispose(), offMode.dispose(), multiUserMode.dispose()]);
    await Promise.all([vault.close(), offVault.close(), multiUserVault.close()]);
  });

  it('revokes the old credential lease and binds a new owner on successful Kit switch', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-credential-switch-'));
    temporaryRoots.push(root);
    const ownerKit = createCredentialKit(root, 'owner', '@scope/kit-owner', ['credentials']);
    const otherKit = createCredentialKit(root, 'other', '@scope/kit-other', ['credentials']);
    instrumentCredentialPlugin(ownerKit, 'owner');
    instrumentCredentialPlugin(otherKit, 'other');
    const secrets = new Map<string, string>();
    const vault = new CredentialVault({
      mode: 'local',
      store: new CredentialStore(path.join(root, 'credentials.sqlite')),
      keyring: {
        get: async (account) => secrets.get(account) ?? null,
        set: async (account, secret) => { secrets.set(account, secret); },
        delete: async (account) => { secrets.delete(account); },
      },
    });
    const events: Array<{ marker: string; credentials: PluginCredentialVault }> = [];
    (globalThis as typeof globalThis & { __credentialLeaseEvents: typeof events }).__credentialLeaseEvents = events;
    const editor = createEditor('credential-switch', {
      assembly: assemblyForKits(ownerKit, otherKit),
      pluginPathRoots: createTestPluginPathRoots(),
      credentialVault: vault,
    });

    await editor.kit.load(ownerKit);
    const ownerLease = events[0].credentials;
    const profile = await ownerLease.put({
      label: 'Owner profile',
      metadata: { host: 'owner.internal' },
      secret: 'owner-secret',
    });
    await editor.kit.load(otherKit);
    const otherLease = events[1].credentials;

    expect(events.map((event) => event.marker)).toEqual(['owner', 'other']);
    await expect(ownerLease.available()).resolves.toBe(false);
    await expect(otherLease.available()).resolves.toBe(true);
    await expect(otherLease.get(profile.id)).rejects.toMatchObject({ code: 'CREDENTIAL_PROFILE_NOT_FOUND' });
    await editor.dispose();
    vault.close();
  });

  it('revokes failed-switch leases and restores the original owner with a new valid lease', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-credential-rollback-'));
    temporaryRoots.push(root);
    const ownerKit = createCredentialKit(root, 'owner', '@scope/kit-owner', ['credentials']);
    const failingKit = createCredentialKit(root, 'failing', '@scope/kit-failing', ['credentials']);
    instrumentCredentialPlugin(ownerKit, 'owner');
    instrumentCredentialPlugin(failingKit, 'failing', true);
    const secrets = new Map<string, string>();
    const vault = new CredentialVault({
      mode: 'local',
      store: new CredentialStore(path.join(root, 'credentials.sqlite')),
      keyring: {
        get: async (account) => secrets.get(account) ?? null,
        set: async (account, secret) => { secrets.set(account, secret); },
        delete: async (account) => { secrets.delete(account); },
      },
    });
    const events: Array<{ marker: string; credentials: PluginCredentialVault }> = [];
    (globalThis as typeof globalThis & { __credentialLeaseEvents: typeof events }).__credentialLeaseEvents = events;
    const editor = createEditor('credential-rollback', {
      assembly: assemblyForKits(ownerKit, failingKit),
      pluginPathRoots: createTestPluginPathRoots(),
      credentialVault: vault,
    });

    await editor.kit.load(ownerKit);
    const originalLease = events[0].credentials;
    const profile = await originalLease.put({
      label: 'Rollback profile',
      metadata: { host: 'rollback.internal' },
      secret: 'rollback-secret',
    });
    await expect(editor.kit.load(failingKit)).rejects.toThrow('credential plugin load failed');
    const failedLease = events[1].credentials;
    const restoredLease = events[2].credentials;

    expect(events.map((event) => event.marker)).toEqual(['owner', 'failing', 'owner']);
    expect(restoredLease).not.toBe(originalLease);
    await expect(originalLease.available()).resolves.toBe(false);
    await expect(failedLease.available()).resolves.toBe(false);
    await expect(restoredLease.available()).resolves.toBe(true);
    await expect(restoredLease.get(profile.id)).resolves.toMatchObject({
      profile: { id: profile.id, label: 'Rollback profile' },
      secret: 'rollback-secret',
    });
    expect(editor.kit.getCurrent()?.name).toBe('@scope/kit-owner');
    await editor.dispose();
    vault.close();
  });
});
