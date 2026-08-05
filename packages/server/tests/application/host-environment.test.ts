import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { captureApplicationHostSecrets } from '../../src/application/host-environment';

describe('application host environment capture', () => {
  it('captures and deletes owner-auth transport secrets before plugins load', () => {
    const env = { HARBORS_APPLICATION_TOKEN: 'secret', HARBORS_NOTIFICATION_PORT: '49123', KEEP: 'yes' };
    expect(captureApplicationHostSecrets(env)).toEqual({
      applicationControlToken: 'secret', notificationPort: 49123,
    });
    expect(env).toEqual({ KEEP: 'yes' });
  });

  it('wires the source or built runner into the production Web server entry', () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, '../../src/index.ts'), 'utf8');

    expect(source).toContain('resolveApplicationPluginRunner()');
    expect(source).toContain('applicationPluginProcess:');
  });
});
