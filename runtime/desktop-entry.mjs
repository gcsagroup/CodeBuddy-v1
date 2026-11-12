import path from 'node:path';
import defaultModel from './default-model.json' with { type: 'json' };

// Electron owns one bundled Node service for all desktop windows. Native
// Harness subprocess runners must inherit Node's execPath, not Electron's.
// Shutdown is acknowledged only after the native Harness and MCP owners close.
// Static imports of the server graph can take a substantial part of a cold
// Windows launch. Report real milestones separately from listener readiness.
const startup = phase => process.send?.({ type: 'starting', phase, pid: process.pid });
startup('loading-runtime');
const { createCompatServer } = await import('./server.mjs');
const service = await createCompatServer({
  dataDir: path.join(process.env.CODEBUDDY_HOME, 'backend'),
  secret: process.env.CODEBUDDY_SERVER__SECRET_KEY,
  defaultModel,
  onRuntimeLoaded: () => startup('opening-profile'),
});
startup('binding-listener');
let closing;
const stop = () => closing ??= service.close().then(() => {
  if (process.connected) process.send?.({ type: 'stopped' }, () => {});
  process.exit(0);
});
process.on('message', data => {
  if (data?.type === 'shutdown') void stop();
  if (data?.type === 'prepare-update') {
    void service.closeForUpdate({ stopTasks: data.stopTasks === true }).then(ready => {
      process.send?.({ type: 'update-prepared', ready }, () => { if (ready) process.exit(0); });
    }).catch(() => process.send?.({ type: 'update-prepared', ready: false }));
  }
});
process.on('disconnect', () => void stop());
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
const url = await service.listen(0, '127.0.0.1');
process.send?.({ type: 'ready', url, engine: 'deepseek-harness', pid: process.pid });
