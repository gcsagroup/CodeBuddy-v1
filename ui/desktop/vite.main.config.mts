import { defineConfig } from 'vite';
import distro from './codebuddy.distro.json';

// https://vitejs.dev/config
export default defineConfig({
  define: {
    'process.env.GITHUB_OWNER': JSON.stringify(process.env.GITHUB_OWNER || ''),
    'process.env.GITHUB_REPO': JSON.stringify(process.env.GITHUB_REPO || ''),
    'process.env.GOOSE_BUNDLE_NAME': JSON.stringify(
      process.env.GOOSE_BUNDLE_NAME || distro.productName
    ),
  },
});
