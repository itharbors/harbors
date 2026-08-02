import { describe, expect, it } from 'vitest';

import { buildProcessTree, observeProcesses, parsePsRows } from '../main/src/process-observer.js';
import type { ProcessSnapshot } from '../main/src/types.js';

describe('process observer', () => {
  it('bounds trees and measures same-executable recursion plus new tasks', () => {
    const snapshots = Array.from({ length: 8 }, (_, index) => process({
      pid: index + 1,
      ppid: index === 0 ? 0 : index,
      processGroupId: 1,
      executableIdentity: 'sha256:claude',
      commandMarkers: index === 0 ? [] : ['task'],
      parentRoleHint: index === 0 ? null : 'host',
    }));

    const tree = buildProcessTree(snapshots, {
      maxNodes: 256,
      previousPids: new Set(),
      classify: (item) => item.commandMarkers.includes('task') ? 'task' : 'host',
    });

    expect(tree.metrics).toMatchObject({
      sameExecutableDepth: 8,
      newTaskProcesses: 7,
      activeTaskProcesses: 7,
    });
    expect(buildProcessTree([...snapshots, ...snapshots.map((item) => ({ ...item, pid: item.pid + 100 }))], {
      maxNodes: 8,
      classify: () => 'task',
    }).processes).toHaveLength(8);
  });

  it('derives task hints from process topology without accepting argv fields', () => {
    const rows = parsePsRows([
      '41\t1\t41\t1000\t/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
      '42\t41\t42\t1001\t/Applications/ChatGPT.app/Contents/Resources/codex',
      '43\t42\t43\t1002\t/opt/bin/claude\tsecret-argv-must-reject',
    ].join('\n'));

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ commandMarkers: [], parentRoleHint: null });
    expect(rows[1]).toMatchObject({ commandMarkers: [], parentRoleHint: 'host' });
    expect(JSON.stringify(rows)).not.toContain('secret-argv');
  });

  it('parses executable paths with spaces from the argv-free macOS layout', () => {
    const rows = parsePsRows(
      '  41     1    41 Wed Jul 30 12:34:56 2026 /Applications/Codex.app/Contents/Frameworks/Codex Helper.app/Contents/MacOS/Codex Helper',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pid: 41, ppid: 1, processGroupId: 41 });
    expect(rows[0].processStartTime).toBeGreaterThan(0);
    expect(rows[0].commandMarkers).toEqual(['helper']);
  });

  it('keeps an allowlisted Claude comm name without accepting unrelated relative executables', () => {
    const rows = parsePsRows([
      '  41     1    41 Wed Jul 30 12:34:56 2026 claude',
      '  42     1    42 Wed Jul 30 12:34:57 2026 node',
    ].join('\n'));

    expect(rows).toEqual([
      expect.objectContaining({
        pid: 41,
        executable: 'claude',
        executableIdentity: 'path:claude',
      }),
    ]);
  });

  it('forces a stable locale when reading the macOS process table', async () => {
    const rows = await observeProcesses({
      execFile: async (_file, _args, options) => ({
        stdout: options.env.LC_ALL === 'C'
          ? '  41     1    41 Wed Jul 30 12:34:56 2026 /Applications/ChatGPT.app/Contents/Resources/codex'
          : '  41     1    41 qua 30 jul 12:34:56 2026 /Applications/ChatGPT.app/Contents/Resources/codex',
      }),
    });

    expect(rows).toEqual([
      expect.objectContaining({ pid: 41, executableIdentity: 'path:/Applications/ChatGPT.app/Contents/Resources/codex' }),
    ]);
  });
});

function process(overrides: Partial<ProcessSnapshot>): ProcessSnapshot {
  return {
    pid: 1,
    ppid: 0,
    processGroupId: 1,
    processStartTime: 1_000,
    executable: '/opt/bin/claude',
    executableIdentity: 'sha256:claude',
    commandMarkers: [],
    parentRoleHint: null,
    ...overrides,
  };
}
