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
  // Keep Forge's generated renderer URL on IPv4 loopback: some Windows VPN
  // filters reject ::1 even when a server successfully listens on it.
  // HMR inherits this URL and the actual listening port. Do not pin clientPort:
  // Vite may choose another port when the default is already occupied.
  server: { host: '127.0.0.1', watch: { ignored: ['**/out/**'] } },

  // Vite caches a copy of @aaif/goose-sdk and doesn't notice when we rebuild it
  // locally, so it serves stale code until you clear node_modules/.vite by hand.
  // Excluding it makes Vite always read the latest ui/sdk/dist build.
  // Dev-server only — release builds ignore optimizeDeps.
  optimizeDeps: {
    exclude: ['@aaif/goose-sdk'],
  },

  build: {
    target: 'esnext',
    rollupOptions: { input: ['index.html', 'completion-popup.html'] },
  },
});
