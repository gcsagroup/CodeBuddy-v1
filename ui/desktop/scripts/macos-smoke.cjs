// Runs the packaged app using Chromium's debugging endpoint (not the disabled Node inspector).
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require('@playwright/test');
const { bundlePaths } = require('./macos-package.cjs');
const { verifyHarnessBundle } = require('./bundle-macos.cjs');
const distro = require('../codebuddy.distro.json');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, predicate, message, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await read();
    if (predicate(value)) return value;
    await sleep(150);
  }
  throw new Error(`Timed out: ${message}`);
}

async function main() {
  if (process.platform !== 'darwin')
    throw new Error('This acceptance script requires a real macOS host.');
  const app =
    process.argv.slice(2).find((arg) => arg !== '--') ||
    bundlePaths(path.resolve(__dirname, '..'), process.arch).app;
  const executable = path.join(app, 'Contents/MacOS', distro.executableName);
  verifyHarnessBundle(app, process.arch);
  const evidence = await fs.mkdtemp(path.resolve(__dirname, `../out/macos-smoke-${process.arch}-`));
  const workspace = path.join(evidence, 'workspace 中文');
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'note.txt'), 'original 中文\n');
  const reserve = net.createServer();
  await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const fixture = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(
      '<!doctype html><title>macOS browser fixture</title><h1>Browser fixture 中文</h1>'
    );
  });
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const child = spawn(executable, [`--remote-debugging-port=${port}`], {
    env: {
      ...process.env,
      CODEBUDDY_HOME: path.join(evidence, 'profile'),
      CODEBUDDY_USER_DATA_DIR: path.join(evidence, 'electron'),
      CODEBUDDY_WORKSPACE_ROOT: workspace,
      CODEBUDDY_MIGRATE_LEGACY: 'false',
      CODEBUDDY_DISABLE_PROTOCOL_REGISTRATION: 'true',
      GOOSE_WORKING_DIR: workspace,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (data) => {
    log += data;
  });
  child.stderr.on('data', (data) => {
    log += data;
  });
  let launchError;
  child.on('error', (error) => {
    launchError = error;
  });
  let browser;
  try {
    await until(
      async () => {
        if (launchError) throw launchError;
        if (child.exitCode !== null) throw new Error(`App exited: ${child.exitCode}`);
        return fetch(`http://127.0.0.1:${port}/json/version`)
          .then((r) => r.ok)
          .catch(() => false);
      },
      Boolean,
      'packaged Electron startup',
      60000
    );
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = await until(
      async () => {
        for (const context of browser.contexts())
          for (const candidate of context.pages()) {
            if (
              await candidate
                .evaluate(() => typeof window.electron?.workspacePanel === 'function')
                .catch(() => false)
            )
              return candidate;
          }
        return undefined;
      },
      Boolean,
      'application preload'
    );
    const scope = { sessionId: 'macos-package-smoke', root: workspace };
    const invoke = (request) =>
      page.evaluate((r) => window.electron.workspacePanel(r), { ...request, scope });
    const listed = await invoke({ action: 'list', path: '' });
    assert.ok(listed.entries.some((entry) => entry.name === 'note.txt'));
    const original = await invoke({ action: 'read', path: 'note.txt' });
    assert.equal(original.document.content, 'original 中文\n');
    await invoke({
      action: 'save',
      path: 'note.txt',
      content: 'saved 中文\n',
      version: original.document.version,
    });
    assert.equal(await fs.readFile(path.join(workspace, 'note.txt'), 'utf8'), 'saved 中文\n');
    const search = await invoke({ action: 'search', query: 'note' });
    assert.ok(search.entries.some((entry) => entry.name === 'note.txt'));
    const terminal = await invoke({ action: 'terminal-create' });
    await invoke({ action: 'terminal-resize', id: terminal.id, cols: 110, rows: 32 });
    // Split the marker so command echo alone cannot satisfy the output assertion.
    await invoke({
      action: 'terminal-input',
      id: terminal.id,
      data: "printf '__MAC_%s__\\n' PTY; pwd; stty size; printf '__TEXT_%s__\\n' '你好🙂'\r",
    });
    const output = await until(
      () => invoke({ action: 'terminal-read', id: terminal.id, offset: 0 }),
      (value) =>
        value.data.includes('__MAC_PTY__') &&
        value.data.includes(workspace) &&
        /(?:^|[\r\n])32\s+110[\r\n]/.test(value.data) &&
        value.data.includes('__TEXT_你好🙂__'),
      'real PTY output, cwd, dimensions and Unicode'
    );
    await fs.writeFile(path.join(evidence, 'terminal.txt'), output.data);
    await invoke({ action: 'terminal-close', id: terminal.id });
    const guest = await invoke({ action: 'browser-create' });
    await invoke({
      action: 'browser-bounds',
      id: guest.id,
      bounds: { x: 50, y: 100, width: 500, height: 400 },
    });
    await invoke({
      action: 'browser-navigate',
      id: guest.id,
      url: `http://127.0.0.1:${fixture.address().port}`,
    });
    await until(
      () => invoke({ action: 'browser-state', id: guest.id }),
      (value) => value.browser.title === 'macOS browser fixture' && !value.browser.loading,
      'WebContentsView navigation'
    );
    await page.screenshot({ path: path.join(evidence, 'application.png') });
    await invoke({ action: 'browser-close', id: guest.id });
    await fs.writeFile(
      path.join(evidence, 'result.json'),
      JSON.stringify(
        {
          status: 'PASS',
          platform: process.platform,
          arch: process.arch,
          app,
          checks: [
            'packaged-startup',
            'workspace-list-read-save-search',
            'real-pty-output-cwd-resize',
            'webcontentsview-http-title',
          ],
          notRun: [
            'model-provider-initialization',
            'real-model-response',
            'Finder launch',
            'public HTTPS',
            'computer control and TCC',
            'search MCP',
            'Git/GitHub MCP',
            'memory persistence',
            'full user interaction',
          ],
        },
        null,
        2
      )
    );
    console.log(`PASS: macOS package smoke. Evidence: ${evidence}`);
  } catch (error) {
    await fs.writeFile(
      path.join(evidence, 'result.json'),
      JSON.stringify({ status: 'FAIL', app, arch: process.arch, error: String(error) }, null, 2)
    );
    console.error(`macOS smoke evidence: ${evidence}`);
    throw error;
  } finally {
    if (browser) await browser.close();
    if (child.exitCode === null && child.pid) {
      child.kill('SIGTERM');
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(5000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await new Promise((resolve) => fixture.close(resolve));
    await fs.writeFile(path.join(evidence, 'electron.log'), log);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
