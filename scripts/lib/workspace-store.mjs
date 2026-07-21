import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class WorkspaceStore {
  constructor(filePath, options = {}) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new TypeError('WorkspaceStore filePath is required');
    }
    this.filePath = filePath;
    this.createUuid = options.randomUUID ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.records = null;
    this.mutation = Promise.resolve();
    this.tempSequence = 0;
  }

  async getOrCreate(kit) {
    const kitName = kit?.name;
    if (typeof kitName !== 'string' || kitName.length === 0) {
      throw new TypeError('Kit name is required');
    }

    return this.mutate(async (records) => {
      const timestamp = this.now();
      let record = records.find((candidate) => candidate.kitName === kitName);
      if (!record) {
        record = {
          kitName,
          sessionId: this.createUuid(),
          createdAt: timestamp,
          lastAccessAt: timestamp,
        };
        records.push(record);
      } else {
        record.lastAccessAt = timestamp;
      }
      await this.persist(records);
      return clone(record);
    });
  }

  async updateBounds(kitName, bounds) {
    const normalizedBounds = normalizeBounds(bounds);
    return this.mutate(async (records) => {
      const record = records.find((candidate) => candidate.kitName === kitName);
      if (!record) {
        throw new Error(`Workspace for Kit "${kitName}" not found`);
      }
      record.bounds = normalizedBounds;
      record.lastAccessAt = this.now();
      await this.persist(records);
      return clone(record);
    });
  }

  async list(availableKits) {
    await this.mutation;
    const records = await this.load();
    const availableNames = availableKits === undefined
      ? null
      : new Set(availableKits.map((kit) => kit.name));
    return records
      .map((record) => ({
        ...clone(record),
        ...(availableNames ? { available: availableNames.has(record.kitName) } : {}),
      }))
      .sort((left, right) => left.kitName.localeCompare(right.kitName));
  }

  mutate(operation) {
    const result = this.mutation.then(async () => operation(await this.load()));
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }

  async load() {
    if (this.records) return this.records;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      this.records = Array.isArray(parsed?.workspaces)
        ? parsed.workspaces.filter(isWorkspaceRecord).map(clone)
        : [];
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        throw error;
      }
      this.records = [];
    }
    return this.records;
  }

  async persist(records) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp-${process.pid}-${this.tempSequence += 1}`;
    const payload = `${JSON.stringify({ version: 1, workspaces: records }, null, 2)}\n`;
    try {
      await writeFile(tempPath, payload, { encoding: 'utf8', mode: 0o600 });
      await rename(tempPath, this.filePath);
    } catch (error) {
      throw new Error(`Failed to persist workspaces: ${error.message}`, { cause: error });
    }
  }
}

function normalizeBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') throw new Error('Invalid bounds');
  const width = normalizeCoordinate(bounds.width);
  const height = normalizeCoordinate(bounds.height);
  if (width === null || height === null || width <= 0 || height <= 0) {
    throw new Error('Invalid bounds: width and height must be positive numbers');
  }

  const normalized = { width, height };
  const x = normalizeCoordinate(bounds.x);
  const y = normalizeCoordinate(bounds.y);
  if (x !== null) normalized.x = x;
  if (y !== null) normalized.y = y;
  return normalized;
}

function normalizeCoordinate(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

function isWorkspaceRecord(record) {
  return record
    && typeof record.kitName === 'string'
    && typeof record.sessionId === 'string'
    && typeof record.createdAt === 'number'
    && typeof record.lastAccessAt === 'number';
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
