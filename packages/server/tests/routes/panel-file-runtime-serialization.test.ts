// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { tsImport } from 'tsx/esm/api';

type RuntimeFactory = (windowObject: Window, documentObject: Document) => unknown;

describe('panel file runtime serialization', () => {
  it('keeps the development loader output self-contained for browser injection', async () => {
    const loaded = await tsImport('../../src/routes/panel-file-runtime.ts', import.meta.url) as {
      PANEL_FILE_RUNTIME_FACTORY_SOURCE: string;
    };
    const factorySource = loaded.PANEL_FILE_RUNTIME_FACTORY_SOURCE;

    expect(factorySource).not.toContain('__name(');
    const reconstructed = Function(`return (${factorySource});`)() as RuntimeFactory;
    expect(() => reconstructed({} as Window, {} as Document)).not.toThrow();
  });
});
