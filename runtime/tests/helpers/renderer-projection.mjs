import { fileURLToPath } from 'node:url';
import { build } from '../../../ui/node_modules/esbuild/lib/main.js';

let renderer;
export async function projectChatUpdates(updates) {
  if (!renderer) {
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL('../../../ui/desktop/src/acp/sessionNotificationAdapter.ts', import.meta.url))],
      bundle: true, platform: 'node', format: 'esm', write: false,
    });
    renderer = (await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))).createAcpSessionNotificationAdapter;
  }
  const adapter = renderer();
  for (const update of updates) adapter.apply({ sessionId: 'history', update });
  return adapter.getMessages();
}
