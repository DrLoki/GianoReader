import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: ['es2021', 'chrome105', 'safari13'],
    outDir: 'dist',
    emptyDirFirst: true,
  },
  server: {
    port: 5180,
  },
});
