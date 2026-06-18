import { defineConfig } from 'vite';

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] }
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: ['es2021', 'chrome105', 'safari13'],
    minify: !process.env.TAURI_DEBUG,
    sourcemap: !!process.env.TAURI_DEBUG,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('pdfjs-dist') && id.includes('pdf.worker')) {
              return 'pdf.worker';
            }
            return 'vendor';
          }
        }
      }
    }
  },
  optimizeDeps: {
    include: ['pdfjs-dist'],
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
