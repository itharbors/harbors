import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../../..', import.meta.url));
const ROW_COUNT = 300_001;
const RSS_BUDGET_BYTES = 256 * 1024 * 1024;

describe('CSV kit memory boundary', () => {
  it('indexes 300k+ streamed rows while returning one page within the RSS budget', async () => {
    const childProgram = String.raw`
      import fs from 'node:fs';
      import os from 'node:os';
      import path from 'node:path';
      import { once } from 'node:events';

      const projectRoot = ${JSON.stringify(projectRoot)};
      const rowCount = ${ROW_COUNT};
      const rssBudgetBytes = ${RSS_BUDGET_BYTES};
      const { createDefaultAssemblyConfig, createEditor } = await import('@itharbors/server/testing');
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-kit-memory-'));
      const sourcePath = path.join(tempDir, 'large.csv');
      let editor;
      let sampler;
      try {
        const writer = fs.createWriteStream(sourcePath, { encoding: 'utf8', flags: 'wx' });
        writer.write('id,value,note\n');
        for (let index = 1; index <= rowCount; index += 1) {
          const line = String(index).padStart(6, '0') + ',value-' + index + ',' + (index % 10 === 0 ? '' : 'note') + '\n';
          if (!writer.write(line)) await once(writer, 'drain');
        }
        writer.end();
        await once(writer, 'close');

        editor = createEditor('csv-kit-memory-boundary', {
          assembly: createDefaultAssemblyConfig(projectRoot, {
            kitSources: [
              { directory: path.join(projectRoot, 'kits/csv'), source: 'development' },
            ],
            defaultKit: '@itharbors/kit-csv',
          }),
          pluginPathRoots: {
            applicationData: tempDir,
            data: path.join(tempDir, 'plugins', 'data'),
            cache: path.join(tempDir, 'plugins', 'cache'),
            temp: path.join(tempDir, 'plugins', 'temp'),
          },
        });
        await editor.kit.load(path.join(projectRoot, 'kits/csv'));
        globalThis.gc?.();
        const baselineRss = process.memoryUsage().rss;
        let peakRss = baselineRss;
        sampler = setInterval(() => {
          peakRss = Math.max(peakRss, process.memoryUsage().rss);
        }, 5);

        const opened = await editor.plugin.callPlugin('@itharbors/csv-core', 'openFile', {
          path: sourcePath,
          encoding: 'utf8',
          delimiter: ',',
          hasHeader: true,
        });
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
        const page = editor.plugin.callPlugin('@itharbors/csv-core', 'getRows', {
          connectionRevision: opened.connectionRevision,
          page: 1,
          pageSize: 25,
          search: '',
          filters: [],
          sort: null,
        });
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
        clearInterval(sampler);
        sampler = undefined;
        const rssDeltaBytes = peakRss - baselineRss;
        if (page.totalRows !== rowCount || page.rows.length !== 25) {
          throw new Error('unexpected query result: ' + JSON.stringify({ totalRows: page.totalRows, returnedRows: page.rows.length }));
        }
        if (rssDeltaBytes > rssBudgetBytes) {
          throw new Error('RSS budget exceeded: ' + JSON.stringify({ baselineRss, peakRss, rssDeltaBytes, rssBudgetBytes }));
        }
        process.stdout.write(JSON.stringify({ rowCount, returnedRows: page.rows.length, baselineRss, peakRss, rssDeltaBytes, rssBudgetBytes }) + '\n');
      } finally {
        if (sampler) clearInterval(sampler);
        await editor?.dispose();
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    `;

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--expose-gc', '--import', 'tsx', '--input-type=module', '--eval', childProgram],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 120_000,
      },
    );
    expect(stderr).toBe('');
    const evidence = JSON.parse(stdout.trim()) as {
      rowCount: number;
      returnedRows: number;
      baselineRss: number;
      peakRss: number;
      rssDeltaBytes: number;
      rssBudgetBytes: number;
    };
    expect(evidence).toMatchObject({
      rowCount: ROW_COUNT,
      returnedRows: 25,
      rssBudgetBytes: RSS_BUDGET_BYTES,
    });
    expect(evidence.peakRss).toBeGreaterThanOrEqual(evidence.baselineRss);
    expect(evidence.rssDeltaBytes).toBeLessThanOrEqual(RSS_BUDGET_BYTES);
  }, 130_000);
});
