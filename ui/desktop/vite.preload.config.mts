import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    ssr: true,
    outDir: '.vite/build',
    rollupOptions: {
      input: { preload: 'src/preload.ts', completionPopupPreload: 'src/completionPopupPreload.ts' },
      output: {
        format: 'cjs',
        inlineDynamicImports: false,
        entryFileNames: '[name].js'
      },
      external: ['electron']
    }
  }
});
