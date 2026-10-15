import { createCompatServer } from './server.mjs';
import path from 'node:path';

// Electron owns one bundled Node service for all desktop windows. Native
// Harness subprocess runners must inherit Node's execPath, not Electron's.
// Shutdown is acknowledged only after the native Harness and MCP owners close.
const service = await createCompatServer({
  dataDir: path.join(process.env.CODEBUDDY_HOME, 'backend'),
  secret: process.env.CODEBUDDY_SERVER__SECRET_KEY,
});
let closing;
const stop = () => closing ??= service.close().then(() => {
  if (process.connected) process.send?.({ type: 'stopped' }, () => {});
  process.exit(0);
});
process.on('message', data => { if (data?.type === 'shutdown') void stop(); });
process.on('disconnect', () => void stop());
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
const url = await service.listen(0, '127.0.0.1');
process.send?.({ type: 'ready', url, engine: 'deepseek-harness', pid: process.pid });
