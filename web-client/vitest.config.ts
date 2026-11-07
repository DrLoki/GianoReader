import { defineConfig } from 'vitest/config';
import { APP_VERSION } from './scripts/app-version.mjs';

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  test: {
    environment: 'jsdom',
  },
});
