import { chromium, expect, test } from '@playwright/test';
import { createServer } from 'vite';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

test('history filters stay above results and remain usable at narrow widths', async ({}, info) => {
  // Includes a fresh Vite dependency build as well as the browser assertions.
  test.setTimeout(120000);
  const cache = await mkdtemp(resolve(tmpdir(), 'cb-history-layout-'));
  const server = await createServer({
    configFile: resolve('vite.renderer.config.mts'), cacheDir: cache,
    optimizeDeps: { entries: ['tests/browser-fixtures/history-layout.html'] },
    plugins: [{ name: 'history-fixture', enforce: 'pre',
      resolveId(source, importer) {
        if (importer?.replaceAll('\\','/').endsWith('/sessions/SessionListView.tsx') && source === '../../acp/sessions') return '\0history-fixture';
      },
      load(id) {
        if (id !== '\0history-fixture') return;
        return `
          const sessions = Array.from({length:10}, (_,i) => ({id:String(i),name:i===0?'优化宠物动画与显示':'项目开发记录 '+i,sessionType:'code_pro',workingDir:'C:/Users/demo/CodeBuddy/workspaces/project-'+i,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),messageCount:3}));
          export const acpListSessions=async(_cursor,filter)=>({sessions:sessions.filter(s=>!filter?.keyword||s.name.includes(filter.keyword)),nextCursor:null});
          export const acpArchiveSession=async id=>{sessions.find(s=>s.id===id).archivedAt=new Date().toISOString()};
          export const acpUnarchiveSession=async id=>{delete sessions.find(s=>s.id===id).archivedAt};
          export const acpDeleteSession=async()=>{};
          export const acpExportSession=async()=>({});
          export const acpForkSession=async()=>({});
          export const acpImportSession=async()=>({});
          export const acpRenameSession=async()=>({});
          export const acpShareSessionNostr=async()=>({});
        `;
      },
    }], server: { host:'127.0.0.1', port:0, hmr:false },
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({channel:process.platform==='win32'?'msedge':undefined});
    const page = await browser.newPage({viewport:{width:1280,height:960}});
    page.on('pageerror', error => console.error('History fixture:', error.message));
    await page.goto(server.resolvedUrls!.local[0]+'tests/browser-fixtures/history-layout.html', {waitUntil:'domcontentloaded'});
    await expect(page.getByRole('button',{name:'优化宠物动画与显示',exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'导入链接',exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'导入会话',exact:true})).toBeVisible();
    await page.locator('.history-row').first().locator('button[aria-haspopup="menu"]').click();
    await expect(page.getByRole('menuitem',{name:/Nostr/})).toHaveCount(0);
    await expect(page.getByRole('menuitem',{name:'导出会话',exact:true})).toBeVisible();
    await page.screenshot({path:info.outputPath('history-actions.png'),animations:'disabled'});
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    const filter=page.locator('.history-project-filter input');
    await filter.click();
    const option=page.getByRole('option').filter({hasText:'project-1'});
    await expect(option).toBeVisible();
    const bounds=await page.locator('.select__menu').boundingBox();
    expect(bounds!.width).toBeLessThan(350);
    expect(await option.evaluate(e=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})).toBe(true);
    await page.screenshot({path:info.outputPath('history-dropdown.png'),fullPage:true});
    await option.click();
    await expect(page.getByRole('button',{name:'项目开发记录 1',exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'优化宠物动画与显示',exact:true})).toHaveCount(0);
    await filter.click(); await page.getByRole('option',{name:'所有项目',exact:true}).click();
    await page.getByRole('searchbox').fill('宠物');
    await expect(page.locator('.history-row')).toHaveCount(1);
    await page.getByRole('searchbox').fill('');
    await expect(page.locator('.history-row')).toHaveCount(10);
    await page.screenshot({path:info.outputPath('history-wide.png'),fullPage:true});
    await page.setViewportSize({width:650,height:960});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await filter.click(); await expect(page.getByRole('option',{name:'所有项目',exact:true})).toBeVisible();
    await page.keyboard.press('Escape');
    await page.screenshot({path:info.outputPath('history-narrow.png'),fullPage:true});
  } finally { await browser?.close(); await server.close(); await rm(cache,{recursive:true,force:true}); }
});
