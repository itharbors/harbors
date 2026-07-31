import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { createTestCodexHome, type TestCodexHome } from '../plugins/traceweave-core/tests/helpers/codex-home.js';

const execute = promisify(execFile);
let home: TestCodexHome | undefined;

afterEach(async () => { await home?.cleanup(); home = undefined; });

describe('real-session verifier', () => {
  it('reports only aggregate read-only results for an eligible Codex Home', async () => {
    home = await createTestCodexHome();
    const script = path.resolve('scripts/verify-real-session.ts');
    const { stdout } = await execute(process.execPath, [script, '--codex-home', home.root], {
      cwd: path.resolve('.'),
    });

    expect(stdout).toContain('TraceWeave real-session verification: PASS');
    expect(stdout).toContain('sessions=2 active=1 archived=1');
    expect(stdout).toMatch(/turns=2 nodes=\d+ edges=\d+/);
    expect(stdout).toContain('source_unchanged=true');
    expect(stdout).not.toContain(home.root);
    expect(stdout).not.toContain('I need to generate a model');
    expect(stdout).not.toContain('must-not-leak');
    expect(stdout).not.toContain('image_edit');
  });
});
