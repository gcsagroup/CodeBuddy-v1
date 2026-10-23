import { createRequire } from 'node:module';
import path from 'node:path';
// Resolve the locked, shipped distribution; never npx-download code at runtime.
const require = createRequire(import.meta.url);
export const playwrightCli = () => path.join(path.dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js');
