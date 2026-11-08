import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveKitPanelUi } from '../../src/framework/kit/panel-ui';

describe('Kit Panel UI entry', () => {
  it('allows only a real JavaScript file inside the Kit root', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-panel-ui-'));
    const kit = path.join(temp, 'kit');
    const outside = path.join(temp, 'outside');
    try {
      fs.mkdirSync(kit);
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(kit, 'ui.js'), '');
      fs.writeFileSync(path.join(outside, 'secret.js'), '');
      fs.symlinkSync(outside, path.join(kit, 'linked'));
      expect(resolveKitPanelUi(kit, undefined)).toBeUndefined();
      expect(resolveKitPanelUi(kit, 'ui.js')).toBe('ui.js');
      for (const value of ['../outside/secret.js', '/tmp/secret.js', 'https://a.test/x.js', 'ui.json', 'linked/secret.js', 'missing.js']) {
        expect(() => resolveKitPanelUi(kit, value)).toThrow();
      }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
