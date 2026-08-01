import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environmentMatchGlobs: [
      ['plugins/**/tests/panel.test.ts', 'jsdom'],
    ],
    include: [
      'tests/**/*.test.ts',
      'plugins/**/tests/**/*.test.ts',
    ],
  },
});
