import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CSV_CORE_REQUEST_NAMES, CSV_TOPICS } from '@itharbors/csv-contracts';

type PluginDefinition = {
  lifecycle?: {
    load?(runtime: Runtime): void;
    unload?(): Promise<void> | void;
  };
  methods: Record<string, (input?: unknown) => unknown>;
};

type Runtime = {
  message: { broadcast(topic: string, payload: unknown): void };
};

type Broadcast = { topic: string; payload: unknown };

let definition: PluginDefinition | undefined;
let root: string | undefined;

afterEach(async () => {
  await definition?.lifecycle?.unload?.();
  definition = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  delete (globalThis as typeof globalThis & { editor?: unknown }).editor;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe('csv-core plugin bridge', () => {
  it('declares every request method and keeps manifest request names aligned', async () => {
    const loaded = await loadDefinition();
    const expected = [
      'sampleFile',
      'openFile',
      'getConnectionState',
      'cancelOpen',
      'closeFile',
      'getSchema',
      'getRows',
      'getColumnStats',
      'exportRows',
      'cancelExport',
    ];

    expect(CSV_CORE_REQUEST_NAMES).toEqual(expected);
    expect(Object.keys(loaded.definition.methods).sort()).toEqual([...expected].sort());
    expect(loaded.manifestRequests).toEqual(Object.fromEntries(expected.map((name) => [name, [name]])));
  });

  it('publishes immutable indexing, progress, ready, and schema snapshots for one open revision', async () => {
    const source = await writeSource('ready.csv', 'name,value\nAda,1\n');
    const loaded = await loadDefinition();

    const opened = await loaded.definition.methods.openFile({
      path: source,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: true,
    }) as { connectionRevision: number; phase: string };

    expect(opened).toMatchObject({
      connectionRevision: 1, phase: 'ready', byteSize: (await stat(source)).size,
      rowCount: 1, columnCount: 2, irregularRowCount: 0,
    });
    const connectionEvents = loaded.broadcasts.filter((event) => event.topic === CSV_TOPICS.connectionChanged);
    const progressEvents = loaded.broadcasts.filter((event) => event.topic === CSV_TOPICS.progressChanged);
    const schemaEvents = loaded.broadcasts.filter((event) => event.topic === CSV_TOPICS.schemaChanged);
    expect(connectionEvents.map((event) => (event.payload as { connectionRevision: number }).connectionRevision))
      .toEqual(expect.arrayContaining([1]));
    expect(progressEvents.map((event) => (event.payload as { connectionRevision: number }).connectionRevision))
      .toEqual(expect.arrayContaining([1]));
    expect(schemaEvents).toHaveLength(1);
    expect(schemaEvents[0].payload).toMatchObject({ connectionRevision: 1 });
    expect(Object.isFrozen(connectionEvents[0].payload)).toBe(true);
    expect(Object.isFrozen(schemaEvents[0].payload)).toBe(true);
  });

  it('keeps the previous ready revision after a replacement fails', async () => {
    const first = await writeSource('first.csv', 'name\nold\n');
    const broken = await writeSource('broken.csv', 'name\n"not closed\n');
    const loaded = await loadDefinition();
    const initial = await loaded.definition.methods.openFile({
      path: first,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: true,
    }) as { connectionRevision: number };

    await expect(loaded.definition.methods.openFile({
      path: broken,
      encoding: 'utf8',
      delimiter: ',',
      hasHeader: true,
    })).resolves.toEqual({
      $csvError: expect.objectContaining({ code: 'CSV_PARSE_FAILED' }),
    });

    expect(loaded.definition.methods.getConnectionState()).toMatchObject({
      connectionRevision: initial.connectionRevision,
      phase: 'ready',
      path: first,
    });
    const lastConnection = loaded.broadcasts
      .filter((event) => event.topic === CSV_TOPICS.connectionChanged)
      .at(-1)?.payload;
    expect(lastConnection).toMatchObject({
      connectionRevision: initial.connectionRevision,
      phase: 'ready',
      path: first,
    });
  });

  it('returns public envelopes for synchronous errors and stale cancellations', async () => {
    const loaded = await loadDefinition();

    expect(loaded.definition.methods.getRows({ connectionRevision: 0 })).toEqual({
      $csvError: expect.objectContaining({ code: 'NO_CONNECTION' }),
    });
    expect(loaded.definition.methods.cancelOpen({ connectionRevision: 99 })).toEqual({
      $csvError: expect.objectContaining({ code: 'STALE_CONNECTION' }),
    });
    expect(loaded.definition.methods.cancelExport({ connectionRevision: 99, exportId: 'missing' })).toEqual({
      $csvError: expect.objectContaining({ code: 'STALE_CONNECTION' }),
    });
  });

  it('awaits exactly one idempotent service disposal during unload', async () => {
    const { CsvService } = await import('../main/src/csv-service.js');
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const dispose = vi.spyOn(CsvService.prototype, 'dispose').mockImplementation(() => pending);
    const loaded = await loadDefinition();

    let settled = false;
    const unloading = Promise.resolve(loaded.definition.lifecycle?.unload?.()).then(() => { settled = true; });
    await Promise.resolve();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    release();
    await unloading;
    await loaded.definition.lifecycle?.unload?.();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

async function loadDefinition(): Promise<{
  definition: PluginDefinition;
  broadcasts: Broadcast[];
  manifestRequests: Record<string, string[]>;
}> {
  const broadcasts: Broadcast[] = [];
  (globalThis as typeof globalThis & { editor?: unknown }).editor = {
    plugin: {
      define(value: PluginDefinition) {
        definition = value;
      },
    },
  };
  await import('../main/src/index.js');
  const runtime: Runtime = {
    message: {
      broadcast(topic, payload) {
        broadcasts.push({ topic, payload });
      },
    },
  };
  definition!.lifecycle?.load?.(runtime);
  const manifest = await import('../package.json', { with: { type: 'json' } });
  return {
    definition: definition!,
    broadcasts,
    manifestRequests: manifest.default['ce-editor'].contribute.message.request,
  };
}

async function writeSource(name: string, contents: string): Promise<string> {
  root ??= await mkdtemp(path.join(os.tmpdir(), 'csv-plugin-main-'));
  const source = path.join(root, name);
  await writeFile(source, contents, 'utf8');
  return source;
}
