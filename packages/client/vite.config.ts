import { resolveCredentialMode } from '@itharbors/host-security';
import { defineConfig } from 'vite';

const host = process.env.HARBORS_BIND_HOST;

resolveCredentialMode({
  hostMode: process.env.HARBORS_HOST_MODE === 'desktop' ? 'desktop' : 'web',
  requested: process.env.HARBORS_CREDENTIAL_MODE,
  bindHost: host,
});

export default defineConfig({
  server: {
    host,
    port: parseInt(process.env.CLIENT_PORT || '48382', 10),
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: 'index.html',
      output: {
        entryFileNames: 'assets/index.js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
