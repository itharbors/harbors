import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: [
      'tests/**/*.test.ts',
      'plugins/**/tests/**/*.test.ts',
      'kits/csv/tests/**/*.test.ts',
      'kits/csv/plugins/**/tests/**/*.test.ts',
    ],
  },
});
