import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const kitRoot = fileURLToPath(new URL('..', import.meta.url));
const projectRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('SQLite kit manifest', () => {
  it('declares six focused plugins with Explorer beside a four-panel tab group', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(kitRoot, 'package.json'), 'utf8'));
    const layout = JSON.parse(fs.readFileSync(path.join(kitRoot, 'layout.json'), 'utf8'));
    const mainEntry = fs.readFileSync(path.join(kitRoot, 'main.html'), 'utf8');
    const secondaryEntry = fs.readFileSync(path.join(kitRoot, 'secondary.html'), 'utf8');

    expect(pkg.name).toBe('@itharbors/kit-sqlite');
    expect(pkg['ce-editor'].kit.plugin).toEqual([
      '@itharbors/sqlite-core',
      '@itharbors/sqlite-explorer',
      '@itharbors/sqlite-data',
      '@itharbors/sqlite-schema',
      '@itharbors/sqlite-relationships',
      '@itharbors/sqlite-sql',
    ]);
    expect(layout.windows[0].layout).toEqual({
      type: 'hsplit',
      sizes: [300, 1],
      children: [
        { type: 'leaf', panel: '@itharbors/sqlite-explorer.explorer' },
        {
          type: 'tab',
          activeIndex: 0,
          children: [
            { type: 'leaf', panel: '@itharbors/sqlite-data.data' },
            { type: 'leaf', panel: '@itharbors/sqlite-schema.schema' },
            { type: 'leaf', panel: '@itharbors/sqlite-relationships.relationships' },
            { type: 'leaf', panel: '@itharbors/sqlite-sql.sql' },
          ],
        },
      ],
    });
    expect(layout.activePanel).toBe('@itharbors/sqlite-data.data');
    expect(mainEntry).toContain('<title>SQLite 工作台</title>');
    expect(secondaryEntry).toContain('<title>SQLite 工作台窗口</title>');
  });

  it('runs the SQLite kit tests from the repository test gate', () => {
    const rootPackage = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
    );

    expect(rootPackage.scripts.test).toContain('npm run test -w @itharbors/kit-sqlite');
  });
});
