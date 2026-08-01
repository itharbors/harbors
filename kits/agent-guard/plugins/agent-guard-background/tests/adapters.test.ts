import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createClaudeAdapter } from '../main/src/adapters/claude.js';
import { createCodexAdapter } from '../main/src/adapters/codex.js';
import type { IncidentEvidence, ProcessSnapshot, ProcessTreeSnapshot } from '../main/src/types.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Claude and Codex adapters', () => {
  it('classifies hosts, tasks, Hooks, and desktop helpers without complete argv', () => {
    const claude = createClaudeAdapter();
    const codex = createCodexAdapter();

    expect(claude.classifyProcess(process({ executable: '/opt/bin/claude', parentRoleHint: null })))
      .toBe('host');
    expect(claude.classifyProcess(process({ executable: '/opt/bin/claude', commandMarkers: ['hook'] })))
      .toBe('hook');
    expect(codex.classifyProcess(process({
      executable: '/Applications/Codex.app/Contents/Frameworks/Codex Helper (Renderer).app/Contents/MacOS/Codex Helper (Renderer)',
      commandMarkers: ['renderer'],
    }))).toBe('host');
    expect(codex.classifyProcess(process({
      executable: '/Applications/ChatGPT.app/Contents/Resources/codex',
      commandMarkers: [], parentRoleHint: 'host',
    }))).toBe('task');
  });

  it('never chooses a host, helper, or host-shared process group as a control target', () => {
    const codex = createCodexAdapter();
    const host = process({ pid: 10, processGroupId: 10 });
    const sharedTask = process({
      pid: 11, ppid: 10, processGroupId: 10, commandMarkers: [], parentRoleHint: 'host',
    });
    const sharedHostTree: ProcessTreeSnapshot = { observedAt: 10_000, processes: [host, sharedTask] };
    const incident: IncidentEvidence = {
      agent: 'codex', confidence: 'confirmed', processIds: [11], evidenceCodes: ['traffic.fixed.trip'],
    };

    expect(codex.selectSafeControlTarget(sharedHostTree, incident)).toBeNull();

    const isolatedTask = { ...sharedTask, pid: 12, processGroupId: 12 };
    expect(codex.selectSafeControlTarget(
      { observedAt: 10_000, processes: [host, isolatedTask] },
      { ...incident, processIds: [12] },
    )).toEqual({
      pid: 12,
      processGroupId: 12,
      processStartTime: isolatedTask.processStartTime,
      executableIdentity: isolatedTask.executableIdentity,
      role: 'task',
    });
  });

  it('discovers only timestamped session identifier hashes without reading transcripts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-session-metadata-'));
    roots.push(root);
    const session = path.join(root, 'session-secret-name.jsonl');
    fs.writeFileSync(session, '{"prompt":"do not read"}\n');
    const observedAt = Date.now();
    fs.utimesSync(session, new Date(observedAt), new Date(observedAt));
    const adapter = createCodexAdapter({ sessionsDirectory: root });

    const activity = await adapter.discoverSessionActivity(observedAt - 1000);

    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ agent: 'codex', kind: 'created' });
    expect(activity[0].sessionIdHash).toMatch(/^[a-f0-9]{16}$/u);
    expect(JSON.stringify(activity)).not.toMatch(/session-secret-name|do not read/iu);
  });
});

function process(overrides: Partial<ProcessSnapshot> = {}): ProcessSnapshot {
  return {
    pid: 10,
    ppid: 1,
    processGroupId: 10,
    processStartTime: 1_000,
    executable: '/usr/local/bin/codex',
    executableIdentity: 'sha256:codex',
    commandMarkers: [],
    parentRoleHint: null,
    ...overrides,
  };
}
