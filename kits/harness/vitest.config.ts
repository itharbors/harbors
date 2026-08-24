import { fileURLToPath } from 'node:url';

export default {
  resolve: {
    alias: {
      '@itharbors/server/testing': fileURLToPath(new URL('../../packages/server/dist/testing.js', import.meta.url)),
    },
  },
  test: {
    exclude: ['**/node_modules/**', '**/.worktrees/**'],
  },
};
