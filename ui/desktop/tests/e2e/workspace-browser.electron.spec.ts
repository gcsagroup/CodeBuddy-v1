import { test, expect, _electron } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('native embedded browser observes, types, clicks, rejects covered targets and releases previews', async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'codebuddy-browser-native-'))
  );
  let application: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    const main = path.join(root, 'main.cjs');
    const preload = path.join(root, 'preload.cjs');
    await fs.writeFile(
      preload,
      `const {contextBridge, ipcRenderer}=require('electron'); contextBridge.exposeInMainWorld('panel', request=>ipcRenderer.invoke('workspace-panel',request));`
    );
    const entry = `
      import {app,BrowserWindow} from 'electron';
      import {registerWorkspacePanel} from ${JSON.stringify(path.resolve('src/workspace-panel/workspacePanelMain.ts'))};
      app.setPath('userData', ${JSON.stringify(path.join(root, 'profile'))});
      app.whenReady().then(async()=>{
        registerWorkspacePanel();
        const win=new BrowserWindow({width:1000,height:750,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,sandbox:true}});
        await win.loadURL('data:text/html,<title>CodeBuddy browser integration</title><h1>Native browser integration</h1>');
      });
    `;
    await build({
      stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' },
      outfile: main,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron', 'node-pty'],
    });
    await fs.writeFile(
      path.join(root, 'index.html'),
      `<meta charset="utf-8"><title>本机预览验收</title>
      <label>姓名<input aria-label="姓名"></label>
      <label><input type="checkbox">同意本地验收</label>
      <label>版本<select><option>基础版</option><option>专业版</option></select></label>
      <button onclick="document.querySelector('output').textContent='你好，'+document.querySelector('input').value">验证</button><output></output>
      <div id="shadow-host"></div>
      <script>
        const outer = document.querySelector('#shadow-host').attachShadow({mode:'open'});
        outer.innerHTML = '<div id="inner"></div>';
        const inner = outer.querySelector('#inner').attachShadow({mode:'open'});
        inner.innerHTML = '<button>影子搜索</button><output></output>';
        inner.querySelector('button').onclick = () => inner.querySelector('output').textContent = '影子搜索成功';
      </script>
      <button onclick="document.querySelector('#cover').style.display='block'">显示遮挡</button>
      <div id="cover" style="display:none;position:fixed;inset:0;background:white">遮挡层</div>`
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await _electron.launch({ args: [main], env });
    const page = await application.firstWindow();
    const scope = { sessionId: 'native-a', root };
    const call = (input: Record<string, unknown>, selectedScope = scope): Promise<any> =>
      page.evaluate(
        ({ input, scope }) =>
          (window as unknown as { panel: (request: unknown) => Promise<unknown> }).panel({
            action: 'browser-control',
            scope,
            ...input,
          }),
        { input, scope: selectedScope }
      );
    const opened = await call({ operation: 'open', htmlPath: 'index.html' });
    const id = opened.id;
    await page.evaluate(
      ({ scope, id }) =>
        (window as unknown as { panel: (r: unknown) => Promise<unknown> }).panel({
          action: 'browser-bounds',
          scope,
          id,
          bounds: { x: 0, y: 80, width: 980, height: 600 },
        }),
      { scope, id }
    );
    const win = await application.browserWindow(page);
    await win.evaluate((window) => window.minimize());
    await expect.poll(() => win.evaluate((window) => window.isMinimized())).toBe(true);
    // A polling renderer may resend its unchanged layout while Windows reports
    // the minimized content size. Restoring must not depend on another DOM resize.
    await page.evaluate(
      ({ scope, id }) =>
        (window as unknown as { panel: (r: unknown) => Promise<unknown> }).panel({
          action: 'browser-bounds',
          scope,
          id,
          bounds: { x: 0, y: 80, width: 980, height: 600 },
        }),
      { scope, id }
    );
    await win.evaluate((window) => window.restore());
    await expect.poll(() => win.evaluate((window) => window.isMinimized())).toBe(false);
    await expect
      .poll(() =>
        win.evaluate((window) =>
          window.contentView.children
            .filter((view) => 'webContents' in view)
            .map((view) => view.getBounds().width)
            .some((width) => width > 900)
        )
      )
      .toBe(true);
    let observed = (await call({ operation: 'observe', id })).result;
    expect(observed.title).toBe('本机预览验收');
    const name = observed.nodes.find((n: any) => n.role === 'textbox' && n.name === '姓名').node;
    const verify = observed.nodes.find((n: any) => n.role === 'button' && n.name === '验证').node;
    await call({ operation: 'type', id, node: name, text: '浏览器测试' });
    await call({ operation: 'click', id, node: verify });
    observed = (await call({ operation: 'observe', id })).result;
    expect(JSON.stringify(observed)).toContain('你好，浏览器测试');
    const consent = observed.nodes.find((n: any) => n.role === 'checkbox');
    expect(consent.checked).toBe('false');
    await call({ operation: 'click', id, node: consent.node });
    observed = (await call({ operation: 'observe', id })).result;
    expect(observed.nodes.find((n: any) => n.role === 'checkbox').checked).toBe('true');
    const version = observed.nodes.find((n: any) => n.role === 'combobox');
    const pro = observed.nodes.find((n: any) => n.role === 'option' && n.name === '专业版');
    await expect(call({ operation: 'click', id, node: pro.node })).rejects.toThrow(
      'owning combobox'
    );
    await call({ operation: 'click', id, node: version.node });
    await call({ operation: 'key', id, key: 'ArrowDown' });
    await call({ operation: 'key', id, key: 'Enter' });
    observed = (await call({ operation: 'observe', id })).result;
    expect(observed.nodes.find((n: any) => n.role === 'combobox').value).toBe('专业版');
    const shadowSearch = observed.nodes.find((n: any) => n.role === 'button' && n.name === '影子搜索');
    await call({ operation: 'click', id, node: shadowSearch.node });
    observed = (await call({ operation: 'observe', id })).result;
    expect(JSON.stringify(observed)).toContain('影子搜索成功');
    await expect(
      call({ operation: 'observe', id }, { sessionId: 'native-b', root })
    ).rejects.toThrow('does not belong');
    const cover = observed.nodes.find(
      (n: any) => n.role === 'button' && n.name === '显示遮挡'
    ).node;
    await call({ operation: 'click', id, node: cover });
    await expect(call({ operation: 'click', id, node: verify })).rejects.toThrow('covered');
    await expect(call({ operation: 'click', id, node: shadowSearch.node })).rejects.toThrow('covered');
    const screenshot = (await call({ operation: 'screenshot', id })).result.content[0];
    expect(screenshot.mimeType).toBe('image/png');
    expect(Buffer.from(screenshot.data, 'base64').length).toBeGreaterThan(100);
    await call({ operation: 'close', id });
    await expect(fetch(opened.result.url)).rejects.toThrow();
    await expect(call({ operation: 'observe', id })).rejects.toThrow('does not belong');
    await expect(call({ operation: 'open', url: 'http://127.0.0.1:1/' })).rejects.toThrow(
      'no usable tab ID was returned'
    );
    expect(await win.evaluate((window) => window.contentView.children.length)).toBe(0);
    await fs.writeFile(path.join(root, 'report.md'), '# Verified report');
    await expect(call({ operation: 'open', htmlPath: 'report.md' })).rejects.toThrow(
      'no usable tab ID was returned'
    );
    expect(await win.evaluate((window) => window.contentView.children.length)).toBe(0);
  } finally {
    await application?.close();
    expect(path.dirname(root)).toBe(await fs.realpath(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
