import { describe, expect, it } from 'vitest';
import { KitModule } from '../kit';
import type { KitDescriptor } from '../kit/types';

describe('KitModule', () => {
  it('stores windowEntries when registering a kit', () => {
    const kit = new KitModule();
    const descriptor: KitDescriptor = {
      name: '@ce/test-kit',
      plugins: [],
      layouts: {
        default: { windows: [] },
      },
      windowEntries: {
        main: 'main.html',
        secondary: 'secondary.html',
      },
    };

    kit.register(descriptor);

    expect(kit.get('@ce/test-kit')).toMatchObject({
      windowEntries: {
        main: 'main.html',
        secondary: 'secondary.html',
      },
    });
  });
});
