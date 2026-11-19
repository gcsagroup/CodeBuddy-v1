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
      `const {contextBridge, ipcRenderer}=require('electron'); const panel=request=>ipcRenderer.invoke('workspace-panel',request);
       contextBridge.exposeInMainWorld('panel', panel); contextBridge.exposeInMainWorld('electron', { workspacePanel: panel });`
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
      <label>版本<select oninput="document.querySelector('#selected-input').textContent='input:'+this.value" onchange="document.querySelector('#selected-change').textContent='change:'+this.value"><option>基础版</option><option>专业版</option><option disabled>停用版</option></select></label>
      <output id="selected-input"></output><output id="selected-change"></output>
      <button onclick="document.querySelector('output').textContent='你好，'+document.querySelector('input').value">验证</button><output></output>
      <button onmousedown="const end=performance.now()+1400;while(performance.now()<end){}">测试耗时操作</button>
      <div id="shadow-host"></div>
      <script>
        console.log('first-build-console');
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
    // The manually opened page above remains independent of the agent's one tab.
    const auto = (target: Record<string, string>) => call({ operation: 'open', reuseAutomationTab: true, ...target });
    const [first, second] = await Promise.all([auto({ htmlPath: 'index.html' }), auto({ htmlPath: './index.html' })]);
    expect(first.id).not.toBe(id);
    expect(second.result).toMatchObject({id:first.result.id,url:first.result.url,view:'controls'});
    expect(second.result.observationId).not.toBe(first.result.observationId);
    const variant = await auto({ url: first.result.url + '?mode=boss' });
    expect(variant.id).toBe(first.id);
    expect((await call({ operation: 'observe', id: first.id })).result.url).toBe(variant.result.url);
    expect((await fetch(first.result.url)).status).toBe(200);
    await expect(auto({ htmlPath: 'missing.html' })).rejects.toThrow();
    expect((await call({ operation: 'console', id: first.id })).result.messages.join()).toContain('first-build-console');
    await fs.writeFile(path.join(root, 'other.html'), '<title>Second build</title><script>console.log("second-build-console")</script>');
    const other = await auto({ htmlPath: 'other.html' });
    expect(other.id).toBe(first.id);
    expect((await call({ operation: 'observe', id: first.id })).result.title).toBe('Second build');
    const messages = (await call({ operation: 'console', id: first.id })).result.messages.join();
    expect(messages).toContain('second-build-console');
    expect(messages).not.toContain('first-build-console');
    await expect(fetch(first.result.url)).rejects.toThrow();
    expect((await call({ operation: 'observe', id })).result.url).toBe(opened.result.url);
    await call({ operation: 'close', id: first.id });
    await expect(fetch(other.result.url)).rejects.toThrow();
    const showBrowser = (tabId: string) => page.evaluate(
      ({ scope, id }) =>
        (window as unknown as { panel: (r: unknown) => Promise<unknown> }).panel({
          action: 'browser-bounds',
          scope,
          id,
          bounds: { x: 0, y: 80, width: 980, height: 600 },
        }),
      { scope, id: tabId }
    );
    await showBrowser(id);
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
    // Mount the product toolbar around the real child WebContentsView.
    const toolbar = await build({
      stdin: { contents: `
        import React from 'react';
        import {createRoot} from 'react-dom/client';
        import {IntlProvider} from 'react-intl';
        import {WorkspaceBrowser} from './src/workspace-panel/WorkspaceBrowser';
        import messages from './src/i18n/compiled/zh-CN.json';
        createRoot(document.getElementById('panel')).render(<IntlProvider locale="zh-CN" messages={messages}>
          <WorkspaceBrowser scope={${JSON.stringify(scope)}} id={${JSON.stringify(id)}} />
        </IntlProvider>);
      `, resolveDir: process.cwd(), loader: 'tsx' },
      bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    });
    await page.evaluate(() => {
      const panel = document.createElement('aside');
      panel.id = 'panel';
      panel.className = 'workspace-panel';
      document.body.append(panel);
    });
    await page.addStyleTag({ path: path.resolve('src/workspace-panel/workspacePanel.css') });
    await page.addStyleTag({ content: '#panel{position:absolute;inset:0 0 0 45%}.wb-browser{height:100%;display:flex;flex-direction:column}.wb-browser>.relative{flex:1}' });
    await page.addScriptTag({ content: toolbar.outputFiles[0].text });
    const status = page.getByRole('status');
    await call({ operation: 'observe', id });
    await expect(status).toHaveAttribute('data-phase', 'completed');
    const edge = page.locator('.wb-control-surface .glow');
    const guestBounds = () => win.evaluate(window => window.contentView.children[0].getBounds());
    await expect(edge).toHaveCSS('animation-name', 'edge-breathe');
    const before = await guestBounds();
    const frame = (await edge.boundingBox())!;
    expect(frame.x).toBeGreaterThan(0);
    expect(before.x).toBeGreaterThan(frame.x);
    expect(before.x + before.width).toBeLessThan(frame.x + frame.width);
    expect(before.y + before.height).toBeLessThan(frame.y + frame.height);
    const banner = (await status.boundingBox())!;
    expect(banner.y + banner.height).toBeLessThanOrEqual(before.y);
    const slow = observed.nodes.find((n: any) => n.name === '测试耗时操作' && n.role === 'button');
    const clicking = call({ operation: 'click', id, node: slow.node });
    await expect(status).toHaveAttribute('data-phase', 'running');
    await expect(status).toContainText('网页控制');
    await fs.writeFile(test.info().outputPath('right-panel-control.png'),
      Buffer.from(await win.evaluate(async window => (await window.capturePage()).toPNG().toString('base64')), 'base64'));
    await clicking;
    await expect(status).toHaveAttribute('data-phase', 'completed');
    await expect(edge).toHaveCount(0);
    expect(await guestBounds()).toEqual(before);
    const name = observed.nodes.find((n: any) => n.role === 'textbox' && n.name === '姓名').node;
    const verify = observed.nodes.find((n: any) => n.role === 'button' && n.name === '验证').node;
    const verifyText = observed.nodes.find(
      (n: any) => n.role === 'StaticText' && n.name === '验证'
    ).node;
    await expect(call({ operation: 'click', id, node: verifyText })).rejects.toThrow(
      'text node, not an element'
    );
    await expect(status).toHaveText(/点击.*失败/);
    await call({ operation: 'type', id, node: name, text: '浏览器测试' });
    await call({ operation: 'click', id, node: verify });
    const captureGuest = () => application!.evaluate(async ({ webContents }, url) => {
      const guest = webContents.getAllWebContents().find(wc => wc.getURL() === url)!;
      return (await guest.capturePage()).toPNG().toString('base64');
    }, opened.result.url);
    const ringPixels = (png: string) => application!.evaluate(({ nativeImage }, data) => {
      const pixels = nativeImage.createFromBuffer(Buffer.from(data, 'base64')).toBitmap();
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (pixels[i] >= 252 && Math.abs(pixels[i + 1] - 180) <= 4 && Math.abs(pixels[i + 2] - 59) <= 4) count++;
      return count;
    }, png);
    let marker = '';
    await expect.poll(async () => {
      marker = await captureGuest();
      return ringPixels(marker);
    }, { intervals: [25, 50], timeout: 1100 }).toBeGreaterThan(15);
    await fs.writeFile(test.info().outputPath('clicked-page.png'), Buffer.from(marker, 'base64'));
    await expect(status).toHaveText(/点击/);
    await expect(status).toHaveAttribute('data-phase', 'completed');
    await status.screenshot({ path: test.info().outputPath('click-feedback.png') });
    const clean = (await call({ operation: 'screenshot', id })).result.content[0].data;
    expect(await ringPixels(clean)).toBe(0);
    observed = (await call({ operation: 'observe', id })).result;
    expect(JSON.stringify(observed)).toContain('你好，浏览器测试');
    const consent = observed.nodes.find((n: any) => n.role === 'checkbox');
    expect(consent.checked).toBe('false');
    await call({ operation: 'click', id, node: consent.node });
    observed = (await call({ operation: 'observe', id })).result;
    expect(observed.nodes.find((n: any) => n.role === 'checkbox').checked).toBe('true');
    const pro = observed.nodes.find((n: any) => n.role === 'option' && n.name === '专业版');
    const disabled = observed.nodes.find((n: any) => n.role === 'option' && n.name === '停用版');
    await expect(call({ operation: 'click', id, node: disabled.node })).rejects.toThrow('disabled');
    await call({ operation: 'click', id, node: pro.node });
    observed = (await call({ operation: 'observe', id })).result;
    expect(observed.nodes.find((n: any) => n.role === 'combobox').value).toBe('专业版');
    expect(JSON.stringify(observed)).toContain('input:专业版');
    expect(JSON.stringify(observed)).toContain('change:专业版');
    const shadowSearch = observed.nodes.find(
      (n: any) => n.role === 'button' && n.name === '影子搜索'
    );
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
    await expect(call({ operation: 'type', id, node: name, text: '不得写入' })).rejects.toThrow('covered');
    await expect(call({ operation: 'click', id, node: pro.node })).rejects.toThrow('covered');
    await expect(call({ operation: 'click', id, node: shadowSearch.node })).rejects.toThrow(
      'covered'
    );
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
    await fs.copyFile(
      path.resolve('../../examples/computer-use/customer-draft.html'),
      path.join(root, 'crm.html')
    );
    const crmOpened = await call({operation: 'open', htmlPath: 'crm.html'});
    const crm = crmOpened.id;
    await showBrowser(crm);
    const observeCrm = async (view: 'page' | 'controls' = 'page') => (await call({operation: 'observe', id: crm, view,
      textValues: [{id:'公司',text:'海风测试'}, {id:'工作邮箱',text:'qa@example.test'}]})).result;
    const form = await observeCrm();
    expect(form.truncated).toBe(true);
    const company = form.candidates.find((item: any) => item.operation === 'type' && item.name === '公司');
    await application.evaluate(async ({webContents}, url) => {
      const guest = webContents.getAllWebContents().find(wc => wc.getURL() === url)!;
      await guest.executeJavaScript(`document.querySelector('input').setAttribute('aria-label', '其他公司')`);
    }, crmOpened.result.url);
    await expect(call({operation: 'type', id: crm, observationId: form.observationId, candidateId: company.id})).rejects.toThrow('changed');
    await application.evaluate(async ({webContents}, url) => {
      const guest = webContents.getAllWebContents().find(wc => wc.getURL() === url)!;
      await guest.executeJavaScript(`document.querySelector('input').removeAttribute('aria-label')`);
    }, crmOpened.result.url);
    const beforeFocus = await observeCrm();
    const focusCandidate = beforeFocus.candidates.find((c: any) => c.operation === 'type' && c.name === '公司' && c.valueId === '公司');
    await application.evaluate(async ({webContents}, url) => {
      const guest = webContents.getAllWebContents().find(wc => wc.getURL() === url)!;
      await guest.executeJavaScript(`document.querySelector('input').addEventListener('focus', function() { this.setAttribute('aria-label', '账单公司'); }, {once:true})`);
    }, crmOpened.result.url);
    await expect(call({operation:'type', id:crm, observationId:beforeFocus.observationId, candidateId:focusCandidate.id})).rejects.toThrow('changed');
    expect(await application.evaluate(async ({webContents}, url) => {
      const guest = webContents.getAllWebContents().find(wc => wc.getURL() === url)!;
      return guest.executeJavaScript(`(() => { const input=document.querySelector('input');input.removeAttribute('aria-label');return input.value; })()`);
    }, crmOpened.result.url)).toBe('');
    let current = await observeCrm('controls');
    for (const name of ['公司', '工作邮箱']) {
      const field = current.nodes.find((item: {role: string; name: string}) => item.role === 'textbox' && item.name === name);
      expect(field).toBeDefined();
      const candidate = current.candidates.find((item: { operation: string; name: string; valueId: string }) => item.operation === 'type' && item.name === name && item.valueId === name);
      expect(candidate).toBeDefined();
      const action = {operation: 'type', id: crm, observationId: current.observationId, candidateId: candidate.id};
      current = (await call(action)).result;
      expect(current.view).toBe('controls');
      expect(current.nodes.length).toBeLessThan(20);
      expect(current.nodes.find((n: any) => n.name === name).value).toBe(name === '公司' ? '海风测试' : 'qa@example.test');
      await expect(call(action)).rejects.toThrow('stale');
    }
    expect((await observeCrm()).nodes).toEqual(expect.arrayContaining([
      ...Object.entries({'公司': '海风测试', '工作邮箱': 'qa@example.test', '账单邮箱': 'billing@example.test', '备注': '保留原备注', '提交次数': '0'})
        .map(([name, value]) => expect.objectContaining({role: 'textbox', name, value})),
    ]));
    const crmScreenshot = (await call({ operation: 'screenshot', id: crm })).result.content[0];
    const crmPng = Buffer.from(crmScreenshot.data, 'base64');
    expect(crmPng.length).toBeGreaterThan(100);
    await fs.writeFile(test.info().outputPath('customer-draft.png'), crmPng);
    await call({operation: 'close', id: crm});
    await fs.copyFile(path.resolve('../../examples/computer-use/dynamic-search.html'), path.join(root, 'search.html'));
    const searchOpened = await call({operation: 'open', htmlPath: 'search.html', textValues:[{id:'query',text:'海风'}]});
    const search = searchOpened.id;
    await showBrowser(search);
    const beforeSearch = searchOpened.result;
    const oldChoice = beforeSearch.candidates.find((c: any) => c.name === '旧客户');
    const query = beforeSearch.candidates.find((c: any) => c.operation === 'type');
    expect(query.valueId).toBe('query');
    const suggestions = (await call({operation: 'type', id: search, observationId: beforeSearch.observationId, candidateId: query.id})).result;
    await expect(call({operation: 'click', id: search, observationId: beforeSearch.observationId, candidateId: oldChoice.id})).rejects.toThrow('stale');
    expect(suggestions.candidates.some((c: any) => c.name === '海风测试')).toBe(true);
    const chosen = suggestions.candidates.find((c: any) => c.name === '海风测试');
    const selected = (await call({operation: 'click', id: search, observationId: suggestions.observationId, candidateId: chosen.id})).result;
    expect(selected.nodes).toEqual(expect.arrayContaining([expect.objectContaining({role:'status',name:'已选客户',text:'海风测试'})]));
    const capture = (await call({operation:'screenshot',id:search})).result;
    expect(capture.browserObservation).toMatchObject({schemaVersion:1,webContentsId:expect.any(Number),navigationRevision:expect.any(Number)});
    expect(await application.evaluate(async ({webContents}, url) => {
      const guest = webContents.getAllWebContents().find(wc => wc.getURL() === url)!;
      return guest.executeJavaScript(`document.querySelector('#chosen').textContent`);
    }, searchOpened.result.url)).toBe('海风测试');
    await call({operation:'close',id:search});
    await fs.copyFile(path.resolve('../../examples/computer-use/candidate-boundaries.html'), path.join(root, 'boundaries.html'));
    const boundaries = await call({operation:'open',htmlPath:'boundaries.html'});
    await showBrowser(boundaries.id);
    let boundary = (await call({operation:'observe',id:boundaries.id})).result;
    expect(boundary.candidates.some((c: any) => c.name === '展开客户表单')).toBe(false);
    while (boundary.nextCandidateOffset !== null && !boundary.candidates.some((c: any) => c.name === '展开客户表单'))
      boundary = (await call({operation:'observe',id:boundaries.id,candidateOffset:boundary.nextCandidateOffset})).result;
    const expand = boundary.candidates.find((c: any) => c.name === '展开客户表单');
    expect(expand, JSON.stringify(boundary.nodes.filter((n: any) => n.name === '展开客户表单'))).toBeDefined();
    await call({operation:'click',id:boundaries.id,observationId:boundary.observationId,candidateId:expand.id});
    boundary = (await call({operation:'observe',id:boundaries.id})).result;
    expect(boundary.nodes.some((n: any) => n.name === '客户公司' && n.role === 'textbox')).toBe(true);
    const blocked = boundary.nodes.find((n: any) => n.name === '被遮挡字段' && n.role === 'textbox');
    await expect(call({operation:'type',id:boundaries.id,node:blocked.node,text:'不得写入'})).rejects.toThrow('covered');
    const disabledField = boundary.nodes.find((n: any) => n.name === '停用工作邮箱' && n.role === 'textbox');
    await expect(call({operation:'type',id:boundaries.id,node:disabledField.node,text:'不得写入'})).rejects.toThrow('disabled');
    const readOnly = boundary.nodes.find((n: any) => n.name === '只读账单邮箱' && n.role === 'textbox');
    await expect(call({operation:'type',id:boundaries.id,node:readOnly.node,text:'不得写入'})).rejects.toThrow('editable');
    await call({operation:'close',id:boundaries.id});
    await fs.writeFile(path.join(root, 'pagination.html'), `<!doctype html><meta charset="utf-8">
      <table><tr><td id="city">杭州 · 有效</td></tr></table>
      <button onclick="document.querySelector('#city').textContent='苏州 · 有效'">下一页</button>`);
    const pagination = await call({operation:'open',htmlPath:'pagination.html',view:'page'});
    await showBrowser(pagination.id);
    const next = pagination.result.candidates.find((c: any) => c.name === '下一页');
    const pageAfter = (await call({operation:'click',id:pagination.id,
      observationId:pagination.result.observationId,candidateId:next.id})).result;
    expect(pageAfter.view).toBe('page');
    expect(JSON.stringify(pageAfter.nodes)).toContain('苏州 · 有效');
    const compact = (await call({operation:'observe',id:pagination.id,view:'controls'})).result;
    const compactNext = compact.candidates.find((c: any) => c.name === '下一页');
    const compactAfter = (await call({operation:'click',id:pagination.id,
      observationId:compact.observationId,candidateId:compactNext.id})).result;
    expect(compactAfter.view).toBe('controls');
    expect(JSON.stringify(compactAfter.nodes)).not.toContain('苏州 · 有效');
    await call({operation:'close',id:pagination.id});
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
