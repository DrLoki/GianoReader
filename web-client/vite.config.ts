import { defineConfig } from 'vite';
import { APP_VERSION } from './scripts/app-version.mjs';

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  build: {
    target: ['es2021', 'chrome105', 'safari13'],
    outDir: 'dist',
    emptyDirFirst: true,
  },
  server: {
    port: 5180,
  },
});
