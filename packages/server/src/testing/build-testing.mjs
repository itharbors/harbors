import { build } from 'esbuild';

await build({
  bundle: true,
  entryPoints: ['src/testing.ts'],
  external: ['@itharbors/*', 'better-sqlite3'],
  format: 'esm',
  outfile: 'dist/testing.js',
  platform: 'node',
  sourcemap: false,
  treeShaking: true,
});
