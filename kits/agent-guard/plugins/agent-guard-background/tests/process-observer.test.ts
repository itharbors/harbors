import { describe, expect, it } from 'vitest';

import { buildProcessTree, parsePsRows } from '../main/src/process-observer.js';
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

  it('discards command text after deriving exact allowlisted markers', () => {
    const rows = parsePsRows([
      '41\t1\t41\t1000\t/usr/local/bin/codex\tcodex exec --prompt secret-text',
      '42\t41\t42\t1001\t/opt/bin/claude\tclaude -p secret-text',
    ].join('\n'));

    expect(rows[0].commandMarkers).toEqual(['exec']);
    expect(rows[1].commandMarkers).toEqual(['hook']);
    expect(JSON.stringify(rows)).not.toContain('secret-text');
  });

  it('parses the fixed macOS ps layout without retaining full commands', () => {
    const rows = parsePsRows(
      '  41     1    41 Wed Jul 30 12:34:56 2026 /usr/local/bin/codex codex exec --prompt secret-text',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pid: 41, ppid: 1, processGroupId: 41 });
    expect(rows[0].processStartTime).toBeGreaterThan(0);
    expect(rows[0].commandMarkers).toEqual(['exec']);
    expect(JSON.stringify(rows)).not.toContain('secret-text');
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
