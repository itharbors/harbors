import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ContextStoreError } from './errors.js';
import { acceptStoreLayout, activateStoreLayout, assertActiveStoreLayout, atomicWriteJson, releaseMigrationLock, resolveStoreLayout, rollbackFreshActivation, type StoreLayout } from './storage-layout.js';
import { foldSurface, messagesFromSurface } from './surface-v1.js';
import type { AppendEventInput, BuildContextInput, BuildContextOutput, ConversationRecord, CurrentStateEntry, TraceEvent } from './types.js';

const SCHEMA_VERSION = 1;
const PROCESS_STARTED_AT = Math.round(Date.now() - process.uptime() * 1000);

export class ContextStore {
  private readonly db: DatabaseSync;
  private readonly layout: StoreLayout;
  private readonly runtimeOwner = randomUUID();

  constructor(dataDirectory: string) {
    this.layout = resolveStoreLayout(dataDirectory);
    const wasFresh = this.layout.fresh;
    this.db = new DatabaseSync(this.layout.databasePath);
    let activated = false;
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      if (!wasFresh) {
        const integrity = this.db.prepare('PRAGMA integrity_check').get() as any;
        if (integrity?.integrity_check !== 'ok') throw new ContextStoreError('DATABASE_CORRUPT');
      }
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS store_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        metadata_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL,
        intent_hash TEXT NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (conversation_id, seq),
        UNIQUE (conversation_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS current_state (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        state_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        value_json TEXT NOT NULL,
        source_seq INTEGER NOT NULL,
        active INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, state_id)
      );
      CREATE TABLE IF NOT EXISTS context_plans (
        plan_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        plan_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS active_turns (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        owner_epoch TEXT NOT NULL,
        owner_pid INTEGER NOT NULL,
        owner_process_started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
      this.initializeMetadata();
      this.applyTombstoneGuards();
      this.recoverAbandonedActiveTurns();
      if (wasFresh) {
        const integrity = this.db.prepare('PRAGMA integrity_check').get() as any;
        if (integrity?.integrity_check !== 'ok') throw new ContextStoreError('MIGRATION_FAILED');
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        activateStoreLayout(this.layout);
        activated = true;
        this.layout.fresh = false;
        assertActiveStoreLayout(this.layout);
        const activatedIntegrity = this.db.prepare('PRAGMA integrity_check').get() as any;
        if (activatedIntegrity?.integrity_check !== 'ok') throw new ContextStoreError('MIGRATION_FAILED');
        acceptStoreLayout(this.layout);
      }
    } catch (error) {
      try { this.db.close(); } catch { /* best effort */ }
      if (wasFresh) {
        try {
          atomicWriteJson(join(this.layout.versionDirectory, 'migration-journal.json'), {
            oldVersionId: null,
            newVersionId: this.layout.pointer.versionId,
            epoch: this.layout.pointer.epoch,
            stage: 'failed',
          });
        } catch { /* retain the original failure */ }
      }
      if (activated) {
        try { rollbackFreshActivation(this.layout); } catch { /* retain the original failure */ }
      }
      if (error instanceof ContextStoreError) throw error;
      throw new ContextStoreError('MIGRATION_FAILED');
    } finally {
      releaseMigrationLock(this.layout);
    }
  }

  getStatus(): { ready: true; schemaVersion: number; storeVersion: string } {
    return { ready: true, schemaVersion: SCHEMA_VERSION, storeVersion: 'storage-v2' };
  }

  createConversation(input: Omit<ConversationRecord, 'status'>): ConversationRecord {
    assertActiveStoreLayout(this.layout);
    if (this.hasTombstone(input.id)) throw new ContextStoreError('CONVERSATION_DELETED');
    const record: ConversationRecord = { ...input, status: 'active' };
    this.db.prepare('INSERT INTO conversations (id, metadata_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(record.id, JSON.stringify(record), record.status, Date.parse(record.createdAt), Date.parse(record.updatedAt));
    return structuredClone(record);
  }

  listConversations(status: 'active' | 'archived' = 'active'): ConversationRecord[] {
    return this.db.prepare('SELECT metadata_json, status FROM conversations WHERE status = ? ORDER BY updated_at DESC, id ASC')
      .all(status).map((row) => ({ ...JSON.parse(String((row as any).metadata_json)), status: (row as any).status }));
  }

  loadConversation(id: string): { conversation: ConversationRecord; events: TraceEvent[]; currentState: CurrentStateEntry[] } {
    return { conversation: this.requireConversation(id), events: this.getConversationTrace(id), currentState: this.getCurrentState(id) };
  }

  appendEvent(input: AppendEventInput): TraceEvent {
    assertActiveStoreLayout(this.layout);
    const frozenIntent = JSON.stringify(input.event);
    const intentHash = digest(frozenIntent);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const conversation = this.requireConversation(input.conversationId);
      if (conversation.status === 'archived') throw new ContextStoreError('CONVERSATION_ARCHIVED');
      const existing = this.db.prepare('SELECT intent_hash, event_json FROM events WHERE conversation_id = ? AND idempotency_key = ?')
        .get(input.conversationId, input.idempotencyKey) as any;
      if (existing) {
        if (existing.intent_hash !== intentHash) throw new ContextStoreError('EVENT_CONFLICT');
        this.db.exec('COMMIT');
        return JSON.parse(String(existing.event_json));
      }
      const next = this.db.prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM events WHERE conversation_id = ?')
        .get(input.conversationId) as any;
      const event: TraceEvent = { ...structuredClone(input.event), seq: Number(next.seq), conversationId: input.conversationId };
      this.db.prepare('INSERT INTO events (conversation_id, seq, idempotency_key, intent_hash, event_json) VALUES (?, ?, ?, ?, ?)')
        .run(input.conversationId, event.seq, input.idempotencyKey, intentHash, JSON.stringify(event));
      this.reduceState(event);
      this.reduceActiveTurn(event);
      this.reduceConversation(event);
      this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(event.time, input.conversationId);
      this.db.exec('COMMIT');
      return structuredClone(event);
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  getConversationTrace(id: string): TraceEvent[] {
    this.requireConversation(id);
    return this.db.prepare('SELECT event_json FROM events WHERE conversation_id = ? ORDER BY seq ASC')
      .all(id).map((row) => JSON.parse(String((row as any).event_json)));
  }

  getConversationTraceSince(id: string, afterSeq = -1): { afterSeq: number; cursor: number; events: TraceEvent[] } {
    const events = this.getConversationTrace(id);
    return { afterSeq, cursor: events.at(-1)?.seq ?? -1, events: events.filter((event) => event.seq > afterSeq) };
  }

  buildContext(input: BuildContextInput): BuildContextOutput {
    if (!Number.isSafeInteger(input.availableInputTokens) || input.availableInputTokens < 0) {
      throw new ContextStoreError('CONTEXT_BUDGET_EXCEEDED');
    }
    const events = this.getConversationTrace(input.conversationId);
    const surface = foldSurface(events);
    let selected = input.mode === 'candidate-v1'
      ? this.selectCandidate(events, surface, input)
      : surface;
    const state = input.mode === 'candidate-v1' ? this.getCurrentState(input.conversationId) : [];
    const stateMessage = state.length > 0 ? [{ role: 'user' as const, content: [{ type: 'text', text: `<conversation-state>${JSON.stringify(state)}</conversation-state>` }] }] : [];
    let messages = [...stateMessage, ...messagesFromSurface(events, selected)];
    let used = estimateTokens(messages);
    if (input.mode === 'candidate-v1' && used > input.availableInputTokens) {
      const protectedSeqs = new Set(expandToolClosure(events, surface, [
        ...selected.filter((seq) => input.turn !== undefined && events[seq]?.data.turn === input.turn),
        ...anchoredSurfaceSeqs(events, surface, input.anchors ?? []),
      ]));
      for (const group of toolClosureGroups(events, selected)) {
        if (used <= input.availableInputTokens) break;
        if (group.some((seq) => protectedSeqs.has(seq))) continue;
        const removed = new Set(group);
        selected = selected.filter((candidate) => !removed.has(candidate));
        messages = [...stateMessage, ...messagesFromSurface(events, selected)];
        used = estimateTokens(messages);
      }
    }
    if (input.mode === 'candidate-v1' && used > input.availableInputTokens) throw new ContextStoreError('CONTEXT_BUDGET_EXCEEDED');
    const planId = randomUUID();
    const output: BuildContextOutput = {
      version: 1,
      planId,
      mode: input.mode ?? 'surface-v1',
      messages,
      sourceSeqs: [...new Set([...state.map((entry) => entry.sourceSeq), ...selected])].sort((left, right) => left - right),
      tokenBreakdown: { available: input.availableInputTokens, used },
      evidence: [...state.map((entry) => ({ sourceSeqs: [entry.sourceSeq], reason: `mandatory-state:${entry.kind}` })), ...selected.map((seq) => ({ sourceSeqs: [seq], reason: input.mode === 'candidate-v1' ? 'candidate-v1' : 'surface-v1' }))],
      historyDigest: digest(JSON.stringify({ state, selected })),
    };
    this.db.prepare('INSERT INTO context_plans (plan_id, conversation_id, created_at, plan_json) VALUES (?, ?, ?, ?)')
      .run(planId, input.conversationId, Date.now(), JSON.stringify({ input, output }));
    return output;
  }

  recallHistory(input: { conversationId: string; query?: string; anchors?: string[]; limit?: number }): Array<{ event: TraceEvent; sourceSeqs: number[] }> {
    const events = this.getConversationTrace(input.conversationId);
    const terms = [...new Set([input.query, ...(input.anchors ?? [])].filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.toLowerCase()))];
    const limit = Number.isSafeInteger(input.limit) ? Math.max(1, Math.min(20, Number(input.limit))) : 8;
    if (terms.length === 0) return events.slice(-limit).map((event) => ({ event, sourceSeqs: [event.seq] }));
    return events.filter((event) => {
      const text = JSON.stringify(event).toLowerCase();
      return terms.some((term) => containsExactAnchor(text, term));
    }).slice(-limit).map((event) => ({ event, sourceSeqs: [event.seq] }));
  }

  archiveConversation(id: string): ConversationRecord {
    assertActiveStoreLayout(this.layout);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const conversation = this.requireConversation(id);
      if (this.db.prepare('SELECT 1 FROM active_turns WHERE conversation_id = ?').get(id)) throw new ContextStoreError('CONVERSATION_BUSY');
      const updated = { ...conversation, status: 'archived' as const, updatedAt: new Date().toISOString() };
      this.insertLifecycleEvent(id, 'conversation/archive', Date.parse(updated.updatedAt));
      this.db.prepare("UPDATE conversations SET metadata_json = ?, status = 'archived', updated_at = ? WHERE id = ?")
        .run(JSON.stringify(updated), Date.parse(updated.updatedAt), id);
      this.db.exec('COMMIT');
      return updated;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  restoreConversation(id: string): ConversationRecord {
    assertActiveStoreLayout(this.layout);
    if (this.hasTombstone(id)) throw new ContextStoreError('CONVERSATION_DELETED');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const conversation = this.requireConversation(id);
      const updated = { ...conversation, status: 'active' as const, updatedAt: new Date().toISOString() };
      this.insertLifecycleEvent(id, 'conversation/restore', Date.parse(updated.updatedAt));
      this.db.prepare("UPDATE conversations SET metadata_json = ?, status = 'active', updated_at = ? WHERE id = ?")
        .run(JSON.stringify(updated), Date.parse(updated.updatedAt), id);
      this.db.exec('COMMIT');
      return updated;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  deleteArchivedConversation(id: string): { id: string } {
    assertActiveStoreLayout(this.layout);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const conversation = this.requireConversation(id);
      if (conversation.status !== 'archived') throw new ContextStoreError('CONVERSATION_BUSY');
      atomicWriteJson(this.tombstonePath(id), { conversationId: id, deletedAt: new Date().toISOString() });
      this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
      this.db.exec('COMMIT');
      return { id };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  close(): void { this.db.close(); }

  private initializeMetadata(): void {
    const values = [
      ['format_version', '2'],
      ['schema_version', String(SCHEMA_VERSION)],
      ['version_id', this.layout.pointer.versionId],
      ['epoch', this.layout.pointer.epoch],
    ] as const;
    for (const [key, value] of values) {
      const existing = this.db.prepare('SELECT value FROM store_metadata WHERE key = ?').get(key) as any;
      if (existing && existing.value !== value) throw new ContextStoreError('STORE_VERSION_STALE');
      this.db.prepare('INSERT OR IGNORE INTO store_metadata (key, value) VALUES (?, ?)').run(key, value);
    }
  }

  private applyTombstoneGuards(): void {
    const directory = join(this.layout.root, 'tombstones');
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -'.json'.length);
      if (!safeConversationId(id)) throw new ContextStoreError('MIGRATION_FAILED');
      const guard = JSON.parse(readFileSync(join(directory, entry.name), 'utf8')) as any;
      if (guard?.conversationId !== id) throw new ContextStoreError('MIGRATION_FAILED');
      this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    }
  }

  private hasTombstone(id: string): boolean {
    return existsSync(this.tombstonePath(id));
  }

  private tombstonePath(id: string): string {
    if (!safeConversationId(id)) throw new ContextStoreError('CONVERSATION_NOT_FOUND');
    return join(this.layout.root, 'tombstones', `${id}.json`);
  }

  private requireConversation(id: string): ConversationRecord {
    const row = this.db.prepare('SELECT metadata_json, status FROM conversations WHERE id = ?').get(id) as any;
    if (!row) throw new ContextStoreError('CONVERSATION_NOT_FOUND');
    return { ...JSON.parse(String(row.metadata_json)), status: row.status };
  }

  private getCurrentState(id: string): CurrentStateEntry[] {
    return this.db.prepare('SELECT state_id, kind, value_json, source_seq FROM current_state WHERE conversation_id = ? AND active = 1 ORDER BY source_seq ASC, state_id ASC')
      .all(id).map((row: any) => ({ stateId: row.state_id, kind: row.kind, value: JSON.parse(String(row.value_json)), sourceSeq: row.source_seq }));
  }

  private reduceState(event: TraceEvent): void {
    const state = event.data;
    if (event.type === 'state/set' && typeof state.stateId === 'string' && typeof state.kind === 'string') {
      this.db.prepare(`INSERT INTO current_state (conversation_id, state_id, kind, value_json, source_seq, active)
        VALUES (?, ?, ?, ?, ?, 1)
        ON CONFLICT(conversation_id, state_id) DO UPDATE SET kind=excluded.kind, value_json=excluded.value_json, source_seq=excluded.source_seq, active=1`)
        .run(event.conversationId, state.stateId, state.kind, JSON.stringify(state.value ?? null), event.seq);
    }
    if ((event.type === 'state/clear' || event.type === 'relation/cancel') && typeof state.stateId === 'string') {
      this.db.prepare('UPDATE current_state SET active = 0, source_seq = ? WHERE conversation_id = ? AND state_id = ?')
        .run(event.seq, event.conversationId, state.stateId);
    }
    if (event.type === 'relation/supersede' && typeof state.targetStateId === 'string') {
      this.db.prepare('UPDATE current_state SET active = 0, source_seq = ? WHERE conversation_id = ? AND state_id = ?')
        .run(event.seq, event.conversationId, state.targetStateId);
      if (typeof state.stateId === 'string' && typeof state.kind === 'string') {
        this.db.prepare(`INSERT INTO current_state (conversation_id, state_id, kind, value_json, source_seq, active)
          VALUES (?, ?, ?, ?, ?, 1)
          ON CONFLICT(conversation_id, state_id) DO UPDATE SET kind=excluded.kind, value_json=excluded.value_json, source_seq=excluded.source_seq, active=1`)
          .run(event.conversationId, state.stateId, state.kind, JSON.stringify(state.value ?? null), event.seq);
      }
    }
  }

  private reduceActiveTurn(event: TraceEvent): void {
    const turnId = typeof event.turnId === 'string'
      ? event.turnId
      : typeof event.data.turnId === 'string'
        ? event.data.turnId
        : undefined;
    if (event.type === 'turn/start') {
      if (!turnId) throw new ContextStoreError('CONVERSATION_BUSY');
      const inserted = this.db.prepare(`INSERT INTO active_turns (conversation_id, turn_id, owner_epoch, owner_pid, owner_process_started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id) DO NOTHING`)
        .run(event.conversationId, turnId, this.runtimeOwner, process.pid, PROCESS_STARTED_AT, event.time);
      if (inserted.changes !== 1) throw new ContextStoreError('CONVERSATION_BUSY');
    } else if (event.type === 'turn/end') {
      if (!turnId) throw new ContextStoreError('CONVERSATION_BUSY');
      const deleted = this.db.prepare('DELETE FROM active_turns WHERE conversation_id = ? AND turn_id = ?')
        .run(event.conversationId, turnId);
      if (deleted.changes !== 1) throw new ContextStoreError('CONVERSATION_BUSY');
    } else if (turnId) {
      this.db.prepare('UPDATE active_turns SET updated_at = ? WHERE conversation_id = ? AND turn_id = ?')
        .run(event.time, event.conversationId, turnId);
    }
  }

  private recoverAbandonedActiveTurns(): void {
    const leases = this.db.prepare('SELECT conversation_id, turn_id, owner_epoch, owner_pid, owner_process_started_at FROM active_turns').all() as any[];
    for (const lease of leases) {
      const ownerPid = Number(lease.owner_pid);
      const sameProcess = ownerPid === process.pid && Number(lease.owner_process_started_at) === PROCESS_STARTED_AT;
      if (sameProcess || (ownerPid !== process.pid && isProcessAlive(ownerPid))) continue;
      this.interruptActiveTurn(String(lease.conversation_id), String(lease.turn_id), String(lease.owner_epoch), 'runtime-owner-exited');
    }
  }

  private interruptActiveTurn(conversationId: string, turnId: string, ownerEpoch: string, reason: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const lease = this.db.prepare('SELECT 1 FROM active_turns WHERE conversation_id = ? AND turn_id = ? AND owner_epoch = ?')
        .get(conversationId, turnId, ownerEpoch);
      if (!lease) { this.db.exec('COMMIT'); return; }
      const time = Date.now();
      const next = this.db.prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM events WHERE conversation_id = ?').get(conversationId) as any;
      const event: TraceEvent = {
        type: 'turn/end',
        seq: Number(next.seq),
        time,
        conversationId,
        turnId,
        data: { turnId, terminalKind: 'failed', reason: { code: 'RUNTIME_INTERRUPTED', message: reason } },
      };
      this.db.prepare('INSERT INTO events (conversation_id, seq, idempotency_key, intent_hash, event_json) VALUES (?, ?, ?, ?, ?)')
        .run(conversationId, event.seq, `lease-recovery:${ownerEpoch}:${turnId}`, digest(JSON.stringify(event)), JSON.stringify(event));
      this.db.prepare('DELETE FROM active_turns WHERE conversation_id = ? AND turn_id = ? AND owner_epoch = ?')
        .run(conversationId, turnId, ownerEpoch);
      this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(time, conversationId);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  private insertLifecycleEvent(conversationId: string, type: string, time: number): TraceEvent {
    const next = this.db.prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM events WHERE conversation_id = ?').get(conversationId) as any;
    const event: TraceEvent = { type, seq: Number(next.seq), time, conversationId, data: {} };
    const frozen = JSON.stringify({ type, time, data: {} });
    this.db.prepare('INSERT INTO events (conversation_id, seq, idempotency_key, intent_hash, event_json) VALUES (?, ?, ?, ?, ?)')
      .run(conversationId, event.seq, `lifecycle:${type}:${randomUUID()}`, digest(frozen), JSON.stringify(event));
    return event;
  }

  private reduceConversation(event: TraceEvent): void {
    const current = this.requireConversation(event.conversationId!);
    const next: ConversationRecord = { ...current, updatedAt: new Date(event.time).toISOString() };
    if (event.type === 'session/title' && typeof event.data.title === 'string') next.title = event.data.title.trim().slice(0, 120) || next.title;
    if (event.type === 'sandbox/mode' && (event.data.mode === 'read-only' || event.data.mode === 'workspace-write' || event.data.mode === 'danger-full-access')) next.sandboxMode = event.data.mode;
    if (event.type === 'approval/policy' && (event.data.policy === 'ask' || event.data.policy === 'always')) next.approvalPolicy = event.data.policy;
    if (event.type === 'turn/start') {
      if (typeof event.data.model === 'string') next.model = event.data.model;
      if (typeof event.data.reasoningEffort === 'string') next.reasoningEffort = event.data.reasoningEffort;
      if (typeof event.data.serviceTier === 'string') next.serviceTier = event.data.serviceTier;
      if (typeof event.data.timeoutMs === 'number') next.timeoutMs = event.data.timeoutMs;
    }
    this.db.prepare('UPDATE conversations SET metadata_json = ? WHERE id = ?').run(JSON.stringify(next), event.conversationId);
  }

  private selectCandidate(events: readonly TraceEvent[], surface: readonly number[], input: BuildContextInput): number[] {
    const current = surface.filter((seq) => input.turn === undefined || events[seq]?.data.turn === input.turn);
    if (current.some((seq) => !hasCompleteToolProtocol(events, surface, seq))) throw new ContextStoreError('PROJECTION_UNAVAILABLE');
    const anchored = anchoredSurfaceSeqs(events, surface, input.anchors ?? []);
    const recent = surface.slice(-8);
    return expandToolClosure(events, surface, [...anchored, ...recent, ...current].filter((seq) => hasCompleteToolProtocol(events, surface, seq)));
  }
}

function estimateTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / 4);
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function containsExactAnchor(text: string, anchor: string): boolean {
  let from = 0;
  while (from <= text.length - anchor.length) {
    const index = text.indexOf(anchor, from);
    if (index < 0) return false;
    const before = text[index - 1];
    const after = text[index + anchor.length];
    const startsWithWord = /[a-z0-9_]/u.test(anchor[0] ?? '');
    const endsWithWord = /[a-z0-9_]/u.test(anchor.at(-1) ?? '');
    if ((!startsWithWord || !before || !/[a-z0-9_]/u.test(before))
      && (!endsWithWord || !after || !/[a-z0-9_]/u.test(after))) return true;
    from = index + 1;
  }
  return false;
}

function safeConversationId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/u.test(value);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function anchoredSurfaceSeqs(events: readonly TraceEvent[], surface: readonly number[], values: readonly string[]): number[] {
  const anchors = [...new Set(values.filter((value) => value.trim()).map((value) => value.toLowerCase()))];
  if (anchors.length === 0) return [];
  return surface.filter((seq) => {
    const text = JSON.stringify(events[seq]).toLowerCase();
    return anchors.some((anchor) => containsExactAnchor(text, anchor));
  });
}

function expandToolClosure(events: readonly TraceEvent[], surface: readonly number[], seeds: readonly number[]): number[] {
  const selected = new Set(seeds);
  const groups = toolClosureGroups(events, surface);
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of groups) {
      if (!group.some((seq) => selected.has(seq)) || group.every((seq) => selected.has(seq))) continue;
      for (const seq of group) selected.add(seq);
      changed = true;
    }
  }
  return [...selected].sort((left, right) => left - right);
}

function toolClosureGroups(events: readonly TraceEvent[], surface: readonly number[]): number[][] {
  const parent = new Map(surface.map((seq) => [seq, seq]));
  const find = (seq: number): number => {
    const value = parent.get(seq);
    if (value === undefined || value === seq) return seq;
    const root = find(value);
    parent.set(seq, root);
    return root;
  };
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  const assistants = new Map<string, number>();
  const results = new Map<string, number>();
  for (const seq of surface) {
    const event = events[seq];
    if (!event) continue;
    if (event.type === 'assistant/message') {
      const calls = (event.data.message as any)?.tool_calls;
      if (Array.isArray(calls)) for (const call of calls) if (typeof call?.id === 'string') assistants.set(call.id, seq);
    }
    if (event.type === 'tool/result') {
      const callId = (event.data.message as any)?.source?.callId;
      if (typeof callId === 'string') results.set(callId, seq);
    }
  }
  for (const [callId, assistantSeq] of assistants) {
    const resultSeq = results.get(callId);
    if (resultSeq !== undefined) union(assistantSeq, resultSeq);
  }
  const groups = new Map<number, number[]>();
  for (const seq of surface) {
    const root = find(seq);
    const group = groups.get(root) ?? [];
    group.push(seq);
    groups.set(root, group);
  }
  return [...groups.values()].sort((left, right) => left[0]! - right[0]!);
}

function hasCompleteToolProtocol(events: readonly TraceEvent[], surface: readonly number[], seq: number): boolean {
  const event = events[seq];
  if (!event) return false;
  const surfaceEvents = surface.map((candidate) => events[candidate]).filter(Boolean);
  if (event.type === 'assistant/message') {
    const calls = (event.data.message as any)?.tool_calls;
    if (!Array.isArray(calls) || calls.length === 0) return true;
    return calls.every((call) => typeof call?.id === 'string' && surfaceEvents.some((candidate) => candidate.type === 'tool/result' && (candidate.data.message as any)?.source?.callId === call.id));
  }
  if (event.type === 'tool/result') {
    const callId = (event.data.message as any)?.source?.callId;
    return typeof callId === 'string' && surfaceEvents.some((candidate) => candidate.type === 'assistant/message' && Array.isArray((candidate.data.message as any)?.tool_calls) && (candidate.data.message as any).tool_calls.some((call: any) => call?.id === callId));
  }
  return true;
}
