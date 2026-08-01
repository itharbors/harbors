import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');

describe('Agent Guard runtime integration', () => {
  it('starts only the background plugin at application scope and keeps the panel lazy', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const kit = manifest['ce-editor'].kit;
    const applicationBootstrap = {
      plugins: kit.startup.plugins.map((name: string) => ({ name, status: 'running' })),
    };
    const sessionCountBeforeOpeningGuard = kit.startup.plugins
      .filter((name: string) => name === '@itharbors/agent-guard-center').length;

    expect(applicationBootstrap.plugins).toContainEqual(expect.objectContaining({
      name: '@itharbors/agent-guard-background',
      status: 'running',
    }));
    expect(sessionCountBeforeOpeningGuard).toBe(0);
    expect(kit.plugin).toEqual(['@itharbors/agent-guard-center']);
  });

  it('ships a crash recovery worker that has no termination authority', () => {
    const watchdog = fs.readFileSync(path.join(root, 'plugins/agent-guard-background/main/src/watchdog.ts'), 'utf8');
    expect(watchdog).toMatch(/spawn\('\/bin\/sh'/u);
    expect(watchdog).toMatch(/detached:\s*true/u);
    expect(watchdog).toMatch(/\/bin\/kill -CONT/u);
    expect(watchdog).not.toMatch(/SIG(?:STOP|TERM|KILL)/u);
  });
});
