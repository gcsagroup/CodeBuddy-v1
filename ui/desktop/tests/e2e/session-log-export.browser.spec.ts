import { chromium, expect, test } from '@playwright/test';
import { createServer } from 'vite';
import { fork } from 'node:child_process';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';

test('sidebar downloads safe diagnostics over actual ACP, preserving native history and cancelled files', async ({}, info) => {
  const backend = fork(resolve('../../runtime/tests/fixtures/session-log-export-server.mjs'), [], {
    silent: true,
  });
  let output = '';
  backend.stderr?.on('data', (data) => {
    output += String(data);
  });
  const ready = await new Promise<{ root: string; wsUrl: string; original: string; nativeJournal: string }>(
    (resolve, reject) => {
      backend.once('message', resolve);
      backend.once('exit', (code) => reject(new Error(`Fixture exited ${code}: ${output}`)));
    }
  );
  const server = await createServer({
    configFile: resolve('vite.renderer.config.mts'),
    cacheDir: join(ready.root, 'vite'),
    server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  await server.listen();
  const browser = await chromium.launch({
    channel: process.platform === 'win32' ? 'msedge' : undefined,
  });
  try {
    const page = await browser.newPage();
    const destination = join(ready.root, 'session-log.jsonl');
    let cancel = true;
    let writes = 0;
    await page.exposeFunction('chooseLogDestination', () => ({
      canceled: cancel,
      filePath: destination,
    }));
    await page.exposeFunction('saveSessionLog', async (file: string, data: string) => {
      expect(file).toBe(destination);
      await writeFile(file, data, 'utf8');
      writes++;
      return true;
    });
    await page.goto(
      server.resolvedUrls!.local[0] +
        'tests/browser-fixtures/session-log-export.html?ws=' +
        encodeURIComponent(ready.wsUrl)
    );
    const open = async () => {
      await page.getByText('Export acceptance', { exact: true }).click({ button: 'right' });
    };
    await open();
    await expect(
      page.getByRole('menuitem', { name: 'View recent model interactions' })
    ).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'View session JSON' })).toBeVisible();
    await page.screenshot({ path: info.outputPath('export-log-menu.png') });
    await page.getByRole('menuitem', { name: 'Export logs' }).click();
    await expect(page.getByRole('textbox', { name: 'File preview' })).toBeVisible();
    await page.getByRole('button', { name: 'Save this preview' }).click();
    expect(writes).toBe(0);
    await expect(stat(destination)).rejects.toThrow();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    cancel = false;
    await open();
    await page.getByRole('menuitem', { name: 'Export logs' }).click();
    await expect(page.getByRole('textbox', { name: 'File preview' })).toBeVisible();
    await page.getByRole('button', { name: 'Save this preview' }).click();
    await expect(page.getByText('Logs saved', { exact: true })).toBeVisible();
    const downloaded = await readFile(destination, 'utf8');
    const rows = downloaded.trim().split('\n').map(line => JSON.parse(line));
    const original = ready.original.trim().split('\n').map(line => JSON.parse(line));
    expect(rows[0].type).toBe('log-export');
    expect(rows[0].restorable).toBe(false);
    expect(rows[0].eventCount).toBe(original.length - 1);
    expect(rows.slice(1).map(row => row.seq)).toEqual(original.slice(1).map(row => row.seq));
    expect(downloaded).not.toContain('Browser export');
    expect(downloaded).not.toContain('native-export');
    expect(downloaded).not.toContain(ready.root);
    expect(await readFile(ready.nativeJournal, 'utf8')).toBe(ready.original);
    expect(writes).toBe(1);
    cancel = true;
    await open();
    await page.getByRole('menuitem', { name: 'Export logs' }).click();
    await expect(page.getByRole('textbox', { name: 'File preview' })).toBeVisible();
    await page.getByRole('button', { name: 'Save this preview' }).click();
    expect(await readFile(destination, 'utf8')).toBe(downloaded);
    expect(await readFile(ready.nativeJournal, 'utf8')).toBe(ready.original);
    expect(writes).toBe(1);
    await page.screenshot({ path: info.outputPath('export-log-saved.png') });
    await info.attach('exported-session', {
      path: destination,
      contentType: 'application/x-ndjson',
    });
  } finally {
    await browser.close();
    await server.close();
    const exited = new Promise((resolve) => backend.once('exit', resolve));
    backend.send('close');
    await exited;
  }
});
