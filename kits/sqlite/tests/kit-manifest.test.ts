import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const kitRoot = fileURLToPath(new URL('..', import.meta.url));
const projectRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('SQLite kit manifest', () => {
  it('declares the workbench plugin and one active panel', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(kitRoot, 'package.json'), 'utf8'));
    const layout = JSON.parse(fs.readFileSync(path.join(kitRoot, 'layout.json'), 'utf8'));

    expect(pkg.name).toBe('@itharbors/kit-sqlite');
    expect(pkg['ce-editor'].kit.plugin).toEqual(['@itharbors/sqlite-workbench']);
    expect(layout.windows[0].layout.panel).toBe('@itharbors/sqlite-workbench.workbench');
    expect(layout.activePanel).toBe('@itharbors/sqlite-workbench.workbench');
  });

  it('runs the SQLite kit tests from the repository test gate', () => {
    const rootPackage = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
    );

    expect(rootPackage.scripts.test).toContain('npm run test -w @itharbors/kit-sqlite');
  });
});
