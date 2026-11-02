/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { dshDocumentPreviewAssets } from './scripts/dsh-document-preview-assets.mjs';
import { resolve } from 'node:path';
import { dshDocumentPreviewAssets } from './scripts/dsh-document-preview-assets.mjs';

const cfg = {
  plugins: [react(), dshDocumentPreviewAssets()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    include: ['src/**/*.{test,spec}.{js,jsx,ts,tsx}'],
    // Git-backed Windows tests can exceed Vitest's 5s default while Rust is
    // compiling in parallel. This remains a bounded timeout and does not delay
    // fast failures.
    testTimeout: 15_000,
  },
} satisfies Record<string, any>;

export default defineConfig(cfg as any);
