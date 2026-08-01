import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');

describe('Agent Guard background plugin', () => {
  it('is panel-free and exposes live plus history application methods', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(manifest['ce-editor'].contribute.panel).toBeUndefined();
    expect(manifest['ce-editor'].contribute.message.request).toEqual({
      getSnapshot: ['getSnapshot'],
      updatePolicy: ['updatePolicy'],
      executeCommand: ['executeCommand'],
      getIncidents: ['getIncidents'],
      getTrafficHistory: ['getTrafficHistory'],
      getHistoryStatus: ['getHistoryStatus'],
      updateHistorySettings: ['updateHistorySettings'],
      clearHistory: ['clearHistory'],
    });
  });

  it('starts and disposes one service through plugin lifecycle', () => {
    const source = fs.readFileSync(path.join(root, 'main/src/index.ts'), 'utf8');
    expect(source).toMatch(/await service\.start\(\)/u);
    expect(source).toMatch(/await service\?\.dispose\(\)/u);
    expect(source).toMatch(/dataDir:\s*runtime\.paths\.data/u);
    expect(source).toMatch(/legacyDataDirs:\s*runtime\.paths\.legacyData/u);
    expect(source).toMatch(/hostMode:\s*runtime\.host\.mode/u);
    expect(source).not.toMatch(/HARBORS_AGENT_GUARD_DATA_DIR/u);
    expect(source).not.toMatch(/panel\s*:/u);
  });
});
