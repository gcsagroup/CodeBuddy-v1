import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { dshDocumentPreviewAssets } from './scripts/dsh-document-preview-assets.mjs';

// https://vitejs.dev/config
export default defineConfig({
  define: {
    'process.env.GOOSE_TUNNEL': JSON.stringify(process.env.GOOSE_TUNNEL !== 'no' && process.env.GOOSE_TUNNEL !== 'none'),
  },

  plugins: [tailwindcss(), dshDocumentPreviewAssets()],

  // Forge writes/patches locked executables here during packaging on Windows.
  // Build outputs are never renderer sources and must not crash the dev watcher.
  server: { watch: { ignored: ['**/out/**'] } },

  // Vite caches a copy of @aaif/goose-sdk and doesn't notice when we rebuild it
  // locally, so it serves stale code until you clear node_modules/.vite by hand.
  // Excluding it makes Vite always read the latest ui/sdk/dist build.
  // Dev-server only — release builds ignore optimizeDeps.
  optimizeDeps: {
    exclude: ['@aaif/goose-sdk'],
  },

  build: {
    target: 'esnext'
  },
});
