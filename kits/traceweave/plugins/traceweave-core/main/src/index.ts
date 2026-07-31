import { homedir } from 'node:os';
import path from 'node:path';

import type {
  LoadRawEvidenceInput,
  LoadRunInput,
  TraceweaveErrorCode,
  TraceweaveErrorEnvelope,
} from '@itharbors/traceweave-contracts';

import { TraceweaveService } from './service.js';

declare const editor: any;

type Runtime = { window: { openPanel(name: string): unknown } };

let runtime: Runtime | undefined;
let service: TraceweaveService | undefined;

function publicError(code: TraceweaveErrorCode, message: string): TraceweaveErrorEnvelope {
  return { $traceweaveError: { code, message } };
}

function immutableSnapshot<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function requireService(): TraceweaveService | TraceweaveErrorEnvelope {
  return service ?? publicError('READ_FAILED', 'TraceWeave is not available');
}

function validRunInput(value: unknown): value is LoadRunInput {
  return value !== null && typeof value === 'object'
    && typeof (value as LoadRunInput).runId === 'string'
    && (value as LoadRunInput).runId.trim().length > 0;
}

function validEvidenceInput(value: unknown): value is LoadRawEvidenceInput {
  return validRunInput(value)
    && typeof (value as LoadRawEvidenceInput).eventId === 'string'
    && (value as LoadRawEvidenceInput).eventId.trim().length > 0;
}

function errorFrom(reason: unknown): TraceweaveErrorEnvelope {
  const message = reason instanceof Error ? reason.message : '';
  if (message === 'RUN_NOT_FOUND') return publicError('RUN_NOT_FOUND', 'Run not found');
  if (message === 'EVIDENCE_NOT_FOUND') return publicError('EVIDENCE_NOT_FOUND', 'Evidence not found');
  return publicError('READ_FAILED', 'Could not read the local Codex session');
}

async function listRuns(): Promise<unknown> {
  const active = requireService();
  if (active instanceof TraceweaveService) {
    try { return immutableSnapshot(await active.listRuns()); } catch (error) { return errorFrom(error); }
  }
  return active;
}

async function loadRun(input: unknown): Promise<unknown> {
  if (!validRunInput(input)) return publicError('INVALID_REQUEST', 'A valid run id is required');
  const active = requireService();
  if (active instanceof TraceweaveService) {
    try { return immutableSnapshot(await active.loadRun(input)); } catch (error) { return errorFrom(error); }
  }
  return active;
}

async function loadRawEvidence(input: unknown): Promise<unknown> {
  if (!validEvidenceInput(input)) {
    return publicError('INVALID_REQUEST', 'Valid run and evidence ids are required');
  }
  const active = requireService();
  if (active instanceof TraceweaveService) {
    try { return immutableSnapshot(await active.loadRawEvidence(input)); } catch (error) { return errorFrom(error); }
  }
  return active;
}

async function refresh(): Promise<unknown> {
  const active = requireService();
  if (active instanceof TraceweaveService) {
    try { return immutableSnapshot(await active.refresh()); } catch (error) { return errorFrom(error); }
  }
  return active;
}

editor.plugin.define({
  lifecycle: {
    load(ctx: Runtime) {
      runtime = ctx;
      service = new TraceweaveService(
        process.env.CODEX_HOME?.trim() || path.join(homedir(), '.codex'),
      );
    },
    unload() {
      service?.dispose();
      service = undefined;
      runtime = undefined;
    },
  },
  methods: {
    listRuns,
    loadRun,
    loadRawEvidence,
    refresh,
    openTracePanel() {
      runtime?.window.openPanel('@itharbors/traceweave-view.trace');
    },
  },
});
