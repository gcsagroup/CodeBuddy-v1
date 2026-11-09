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
  const startupAt = Date.now();
  output.write(`[Harness service starting] ${new Date(startupAt).toISOString()}\n`);
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
  let readyToServe = false;
  let exited = false;
  let exitCode: number | null = null;
  const exit = new Promise<void>(resolve => child.once('exit', (code) => {
    exitCode = code;
    exited = true; output.end(resolve);
    if (readyToServe && !stopping) options.onUnexpectedExit();
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
      const milestones = ['loading-runtime', 'opening-profile', 'binding-listener'];
      let next = 0;
      let phase = 'starting-process';
      const timeout = () => fail(new Error(`CodeBuddy startup timed out during ${phase}; see logs/harness/runtime.log`));
      let timer = setTimeout(timeout, 30000);
      const cleanup = () => {
        clearTimeout(timer);
        child.off('exit', onExit).off('message', receive).off('error', fail);
      };
      const fail = (error: Error) => { cleanup(); reject(error); };
      const onExit = () => fail(new Error('Packaged CodeBuddy exited before readiness'));
      const receive = (message: unknown) => {
        if (!message || typeof message !== 'object' || Array.isArray(message)) return;
        const data = message as { type?: string; phase?: string; engine?: string; url?: string; pid?: number };
        if (data.type === 'starting' && data.pid === child.pid && next < milestones.length && data.phase === milestones[next]) {
          phase = milestones[next++];
          output.write(`[Harness service starting] ${phase} +${Date.now() - startupAt} ms\n`);
          clearTimeout(timer);
          timer = setTimeout(timeout, 30000);
          return;
        }
        if (data.type !== 'ready' || data.engine !== 'deepseek-harness' || typeof data.url !== 'string' || typeof data.pid !== 'number') return;
        const url = new URL(data.url);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) return;
        cleanup();
        readyToServe = true;
        output.write(`[Harness service ready] +${Date.now() - startupAt} ms\n`);
        resolve({ url: url.origin, pid: data.pid });
      };
      child.once('exit', onExit).once('error', fail).on('message', receive);
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
          // Cancellation and durable writes can exceed 30 seconds. Never kill
          // the service or proceed with installation on a timer alone.
          const cleanup = () => {
            child.off('message', receive);
            child.off('exit', onExit);
            child.off('disconnect', onDisconnect);
          };
          const fail = () => {
            cleanup();
            reject(new Error('运行服务在保存确认前断开，更新尚未安装。请重启应用后重试。'));
          };
          const onExit = () => fail();
          const onDisconnect = () => fail();
          const receive = (message: unknown) => {
            if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'update-prepared') return;
            cleanup();
            resolve('ready' in message && message.ready === true);
          };
          child.on('message', receive);
          child.once('exit', onExit);
          child.once('disconnect', onDisconnect);
          try {
            child.send({ type: 'prepare-update', stopTasks: true }, error => { if (error) fail(); });
          } catch { fail(); }
        });
        if (!allowed) throw new Error('停止任务或保存记录失败，更新尚未安装。请重启应用后重试。');
        await exit;
        if (exitCode !== 0) throw new Error('运行服务未正常退出，更新尚未安装。请重启应用后重试。');
      } catch (error) { stopping = false; throw error; }
    };
    return { ...ready, secret, close, closeForUpdate };
  } catch (error) { await close(); throw error; }
}
