import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const kitRoot = fileURLToPath(new URL('..', import.meta.url));
const projectRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('MySQL kit manifest', () => {
  it('declares one MySQL workbench panel', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(kitRoot, 'package.json'), 'utf8'),
    );
    const plugin = JSON.parse(fs.readFileSync(
      path.join(kitRoot, 'plugins/mysql-workbench/package.json'),
      'utf8',
    ));
    const layout = JSON.parse(
      fs.readFileSync(path.join(kitRoot, 'layout.json'), 'utf8'),
    );
    const mainEntry = fs.readFileSync(path.join(kitRoot, 'main.html'), 'utf8');
    const secondaryEntry = fs.readFileSync(path.join(kitRoot, 'secondary.html'), 'utf8');

    expect(pkg.name).toBe('@itharbors/kit-mysql');
    expect(pkg.dependencies.mysql2).toBe('^3.23.0');
    expect(pkg['ce-editor'].kit.plugin).toEqual(['@itharbors/mysql-workbench']);
    expect(layout.windows[0].layout.panel).toBe(
      '@itharbors/mysql-workbench.workbench',
    );
    expect(layout.activePanel).toBe('@itharbors/mysql-workbench.workbench');
    expect(plugin['ce-editor'].contribute.panel.workbench.title).toBe(
      'MySQL 工作台',
    );
    expect(mainEntry).toContain('<title>MySQL 工作台</title>');
    expect(secondaryEntry).toContain('<title>MySQL 工作台窗口</title>');
  });

  it('runs the MySQL kit tests from the repository test gate', () => {
    const rootPackage = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
    );

    expect(rootPackage.scripts.test).toContain(
      'npm run test -w @itharbors/kit-mysql',
    );
  });
});
