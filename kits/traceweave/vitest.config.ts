import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    environmentMatchGlobs: [['plugins/traceweave-view/tests/**', 'jsdom']],
    include: ['tests/**/*.test.ts', 'plugins/**/tests/**/*.test.ts', 'plugins/**/tests/**/*.test.tsx'],
  },
});
