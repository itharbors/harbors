import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildKit, inspectKit, packKit } from '@itharbors/kit-cli';
import { describe, expect, it } from 'vitest';

const kitRoot = path.resolve(__dirname, '..');
const execFileAsync = promisify(execFile);

describe('Agent Guard Kit manifest', () => {
  it('declares a native macOS guard with a lazy center and startup background', () => {
    const manifest = readJson(path.join(kitRoot, 'kit.json'));
    const pkg = readJson(path.join(kitRoot, 'package.json'));
    const layout = readJson(path.join(kitRoot, 'layout.json'));

    expect(manifest).toMatchObject({
      id: '@itharbors/kit-agent-guard',
      target: { platform: 'darwin', arch: 'arm64' },
      permissions: ['network', 'filesystem', 'process-control', 'application-startup', 'notifications'],
    });
    expect(pkg['ce-editor'].kit.startup.plugins).toEqual([
      '@itharbors/agent-guard-background',
    ]);
    expect(pkg['ce-editor'].kit.plugin).toEqual([
      '@itharbors/agent-guard-center',
    ]);
    expect(layout.activePanel).toBe('@itharbors/agent-guard-center.guard');
  });

  it('ships the exact versioned v1 guard thresholds without proxy dependencies', () => {
    const policy = readJson(path.join(
      kitRoot,
      'plugins/agent-guard-background/resources/policy-v1.json',
    ));
    const pkg = readJson(path.join(kitRoot, 'package.json'));

    expect(policy).toMatchObject({
      schemaVersion: 1,
      evaluationWindowSeconds: 60,
      consecutiveWindows: 3,
      trafficWindowMinutes: 10,
      dynamicWarning: {
        medianMultiplier: 5,
        madMultiplier: 6,
        minOutboundMiBPerMinute: 8,
        corroborators: { sessionsPerMinute: 6, tasksPerMinute: 8, connectionsPerMinute: 20 },
      },
      fixedWarning: { outboundMiB: 128, sessionsOrTasks: 20 },
      fixedTrip: { outboundMiB: 256, sessionsOrTasks: 30 },
      structuralTrip: {
        recursiveDepth: 4,
        recursiveTasks: 8,
        recursiveWindowSeconds: 120,
        burstTasks: 20,
        burstActiveTasks: 8,
        burstWindowSeconds: 60,
      },
    });
    expect(JSON.stringify(pkg)).not.toMatch(/proxy|sqlite|database/iu);
  });

  it('packs the background policy into the immutable Kit artifact', async () => {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'agent-guard-hkit-'));
    const archive = path.join(temporaryDirectory, 'agent-guard.hkit');
    try {
      await packKit({ directory: kitRoot, output: archive });
      const inspected = await inspectKit({ archive });

      expect(inspected.checksums.map((entry) => entry.path)).toContain(
        'plugins/agent-guard-background/resources/policy-v1.json',
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('owns its contracts, smoke lifecycle, and storage declaration', () => {
    const pkg = readJson(path.join(kitRoot, 'package.json'));
    const localContracts = path.join(kitRoot, 'packages/contracts/package.json');
    const localSmoke = path.join(kitRoot, 'scripts/smoke.mjs');

    expect(pkg.workspaces).toEqual(['packages/*', 'plugins/*']);
    expect(pkg.scripts['build:prepare']).toBeUndefined();
    expect(pkg.scripts['test:kit']).toBe('vitest run --config vitest.config.ts');
    expect(pkg.scripts.smoke).toBe('node scripts/smoke.mjs');
    expect(pkg.harbors.scripts).toEqual({ build: 'build', test: 'test:kit', smoke: 'smoke' });
    expect(pkg.harbors.storage.legacyDataDirectories).toEqual(['agent-guard']);
    expect(fs.existsSync(localContracts)).toBe(true);
    expect(fs.existsSync(localSmoke)).toBe(true);

    const contracts = readJson(localContracts);
    expect(contracts.name).toBe('@itharbors/agent-guard-contracts');
    expect(pkg.dependencies['@itharbors/agent-guard-contracts']).toBe('file:packages/contracts');
    for (const plugin of ['agent-guard-background', 'agent-guard-center']) {
      const pluginPackage = readJson(path.join(kitRoot, 'plugins', plugin, 'package.json'));
      expect(pluginPackage.dependencies['@itharbors/agent-guard-contracts']).toBe(
        'file:../../packages/contracts',
      );
    }

  });

  it('packs the Kit-local contracts workspace instead of relying on repository resolution', async () => {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'agent-guard-contracts-hkit-'));
    const isolatedKit = path.join(temporaryDirectory, 'kit');
    const archive = path.join(temporaryDirectory, 'agent-guard.hkit');
    try {
      await cp(kitRoot, isolatedKit, {
        recursive: true,
        filter: (source) => !source.split(path.sep).some((segment) => (
          segment === 'node_modules' || segment === 'dist' || segment === '.vite'
        )),
      });
      await execFileAsync('npm', ['install', '--ignore-scripts', '--prefix', isolatedKit]);
      await buildKit({ directory: isolatedKit });
      await packKit({ directory: isolatedKit, output: archive });
      const inspected = await inspectKit({ archive });
      expect(inspected.checksums.map((entry) => entry.path)).toEqual(expect.arrayContaining([
        'node_modules/@itharbors/agent-guard-contracts/package.json',
        'node_modules/@itharbors/agent-guard-contracts/dist/contracts.js',
        'node_modules/@itharbors/agent-guard-contracts/dist/index.js',
      ]));
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }, 30_000);
});

function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
