import type { DatabaseLayoutIdentity } from './identity.js';
import type { NodePosition, PersistedRelationshipStateV1 } from './types.js';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

type LayoutBucketEntryV1 = {
  identity: string;
  updatedAt: number;
  state: PersistedRelationshipStateV1;
};

type LayoutBucketV1 = {
  version: 1;
  entries: LayoutBucketEntryV1[];
};

export type RelationshipLayoutStore = {
  load(identity: DatabaseLayoutIdentity): Promise<PersistedRelationshipStateV1 | null>;
  save(identity: DatabaseLayoutIdentity, state: PersistedRelationshipStateV1): Promise<void>;
};

export type RelationshipLayoutStoreOptions = {
  digest?: (value: string) => Promise<string>;
  now?: () => number;
};

const CACHE_PREFIX = 'itharbors:relationship-layout:v1';
const MAX_BUCKET_ENTRIES = 8;
const MAX_ABSOLUTE_COORDINATE = 10_000_000;
const MAX_CANVAS_SIZE = 1_000_000;

export function createRelationshipLayoutStore(
  storage: StorageLike,
  options: RelationshipLayoutStoreOptions = {},
): RelationshipLayoutStore {
  const digest = options.digest ?? defaultDigest;
  const now = options.now ?? Date.now;

  const keyFor = async (identity: DatabaseLayoutIdentity): Promise<string> => {
    const value = await digest(identity.canonical);
    if (value === '') throw new Error('Layout identity digest must not be empty');
    return `${CACHE_PREFIX}:${identity.engine}:${value}`;
  };

  return {
    async load(identity) {
      try {
        const key = await keyFor(identity);
        const bucket = parseBucket(storage.getItem(key));
        const entry = bucket?.entries.find((candidate) => (
          candidate.identity === identity.canonical
        ));
        return entry === undefined ? null : cloneState(entry.state);
      } catch {
        return null;
      }
    },

    async save(identity, state) {
      try {
        const clonedState = cloneState(state);
        if (clonedState === null) return;
        const key = await keyFor(identity);
        const current = parseBucket(storage.getItem(key));
        const entries = (current?.entries ?? [])
          .filter((entry) => entry.identity !== identity.canonical);
        entries.push({ identity: identity.canonical, updatedAt: now(), state: clonedState });
        entries.sort((left, right) => (
          left.updatedAt - right.updatedAt
          || left.identity.localeCompare(right.identity, 'en')
        ));
        const bucket: LayoutBucketV1 = {
          version: 1,
          entries: entries.slice(-MAX_BUCKET_ENTRIES),
        };
        storage.setItem(key, JSON.stringify(bucket));
      } catch {
        // Layout persistence is best-effort and must never block the graph.
      }
    },
  };
}

function parseBucket(raw: string | null): LayoutBucketV1 | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries)) return null;

  const entries: LayoutBucketEntryV1[] = [];
  for (const candidate of value.entries) {
    if (!isRecord(candidate)
      || typeof candidate.identity !== 'string'
      || !isFiniteNumber(candidate.updatedAt)) continue;
    const state = cloneState(candidate.state);
    if (state === null) continue;
    entries.push({
      identity: candidate.identity,
      updatedAt: candidate.updatedAt,
      state,
    });
  }
  return { version: 1, entries };
}

function cloneState(value: unknown): PersistedRelationshipStateV1 | null {
  if (!isRecord(value)
    || !isRecord(value.nodes)
    || !isRecord(value.viewport)
    || !isRecord(value.canvas)) return null;

  const viewport = value.viewport;
  const canvas = value.canvas;
  if (!isCoordinate(viewport.x)
    || !isCoordinate(viewport.y)
    || !isFiniteNumber(viewport.scale)
    || viewport.scale < 0.3
    || viewport.scale > 2
    || !isFiniteNumber(canvas.width)
    || !isFiniteNumber(canvas.height)
    || canvas.width <= 0
    || canvas.height <= 0
    || canvas.width > MAX_CANVAS_SIZE
    || canvas.height > MAX_CANVAS_SIZE) return null;

  const nodes: Array<[string, NodePosition]> = [];
  for (const [name, position] of Object.entries(value.nodes)) {
    if (!isRecord(position) || !isCoordinate(position.x) || !isCoordinate(position.y)) continue;
    nodes.push([name, { x: position.x, y: position.y }]);
  }
  return {
    nodes: Object.fromEntries(nodes),
    viewport: { x: viewport.x, y: viewport.y, scale: viewport.scale },
    canvas: { width: canvas.width, height: canvas.height },
  };
}

async function defaultDigest(value: string): Promise<string> {
  try {
    if (globalThis.crypto?.subtle !== undefined) {
      const bytes = new TextEncoder().encode(value);
      const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    }
  } catch {
    // Fall through to a stable local digest.
  }
  return fnv1a(value);
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isCoordinate(value: unknown): value is number {
  return isFiniteNumber(value) && Math.abs(value) <= MAX_ABSOLUTE_COORDINATE;
}
