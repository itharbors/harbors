import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: parseInt(process.env.CLIENT_PORT || '48382', 10),
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: 'index.html',
    },
  },
});
