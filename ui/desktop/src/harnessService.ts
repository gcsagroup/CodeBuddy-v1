import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createRotatingLog } from '../../../runtime/rotating-log.cjs';

export async function startHarnessService(options: {
  resourcesPath: string;
  home: string;
  workspace: string;
  onUnexpectedExit: () => void;
}) {
  // Merged Windows app-container directories can resolve differently from files.
  // Anchor the trusted package root to the actual manifest, not its directory.
  // Native tool identity checks still reject links or changes below that root.
  const manifestFile = fs.realpathSync.native(path.join(options.resourcesPath, 'harness-distribution', 'manifest.json'));
  const root = path.dirname(manifestFile);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.engine !== 'deepseek-harness' || manifest.schemaVersion !== 1) {
    throw new Error('The packaged CodeBuddy runtime manifest is invalid');
  }
  const node = path.join(root, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
  if (!fs.statSync(node).isFile()) throw new Error('The bundled Node runtime is missing');
  fs.mkdirSync(options.workspace, { recursive: true });
  const logs = path.join(options.home, 'logs', 'harness');
  fs.mkdirSync(logs, { recursive: true });
  const secret = randomBytes(32).toString('hex');
  const output = createRotatingLog(path.join(logs, 'runtime.log'));
  const child = spawn(node, [path.join(root, 'runtime', 'desktop-entry.mjs')], {
    windowsHide: true,
    cwd: options.workspace,
    env: { ...process.env, CODEBUDDY_HOME: options.home, CODEBUDDY_SERVER__SECRET_KEY: secret },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout?.pipe(output, { end: false });
  child.stderr?.pipe(output, { end: false });
  output.on('error', error => {
    console.error('Harness log output failed:', error.message);
    child.stdout?.resume();
    child.stderr?.resume();
  });
  let stopping = false;
  let exited = false;
  const exit = new Promise<void>(resolve => child.once('exit', () => {
    exited = true; output.end(resolve);
    if (!stopping) options.onUnexpectedExit();
  }));
  let closePromise: Promise<void> | undefined;
  const close = () => closePromise ??= (async () => {
    stopping = true;
    if (exited) { await exit; return; }
    if (child.connected) child.send({ type: 'shutdown' }, () => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([exit, new Promise<void>(resolve => {
      timer = setTimeout(() => { child.kill(); resolve(); }, 15000);
    })]);
    clearTimeout(timer);
  })();
  try {
    const ready = await new Promise<{ url: string; pid: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CodeBuddy startup timed out; see logs/harness/runtime.log')), 30000);
      const onExit = () => { clearTimeout(timer); reject(new Error('Packaged CodeBuddy exited before readiness')); };
      child.once('exit', onExit);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.on('message', message => {
        if (!message || typeof message !== 'object' || Array.isArray(message)) return;
        const data = message as { type?: string; engine?: string; url?: string; pid?: number };
        if (data.type !== 'ready' || data.engine !== 'deepseek-harness' || typeof data.url !== 'string' || typeof data.pid !== 'number') return;
        const url = new URL(data.url);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) return;
        clearTimeout(timer); child.removeListener('exit', onExit);
        resolve({ url: url.origin, pid: data.pid });
      });
    });
    fs.writeFileSync(path.join(logs, 'launch.json'), JSON.stringify({
      engine: 'deepseek-harness', startedAt: new Date().toISOString(), ...ready,
      resourcesPath: root, sourceDigest: manifest.sourceDigest,
    }, null, 2));
    const closeForUpdate = async () => {
      if (exited || stopping || !child.connected) throw new Error('运行服务状态异常，请重启应用后再更新。');
      stopping = true;
      try {
        const allowed = await new Promise<boolean>((resolve, reject) => {
          const timer = setTimeout(() => { child.off('message', receive); reject(new Error('等待任务保存超时，请稍后重试。')); }, 30000);
          const receive = (message: unknown) => {
            if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'update-prepared') return;
            clearTimeout(timer); child.off('message', receive);
            resolve('ready' in message && message.ready === true);
          };
          child.on('message', receive);
          child.send({ type: 'prepare-update' });
        });
        if (!allowed) throw new Error('仍有任务或设置操作正在执行，请等待完成后再更新。');
        await exit;
      } catch (error) { stopping = false; throw error; }
    };
    return { ...ready, secret, close, closeForUpdate };
  } catch (error) { await close(); throw error; }
}
