import { chromium, expect, test } from '@playwright/test';
import { createServer } from 'vite';
import { fork } from 'node:child_process';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';

test('sidebar exports an actual Harness journal over ACP; cancellation leaves the file intact', async ({}, info) => {
  const backend = fork(resolve('../../runtime/tests/fixtures/session-log-export-server.mjs'), [], {
    silent: true,
  });
  let output = '';
  backend.stderr?.on('data', (data) => {
    output += String(data);
  });
  const ready = await new Promise<{ root: string; wsUrl: string; expected: string }>(
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
    const destination = join(ready.root, 'exported-session.jsonl');
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
    expect(writes).toBe(0);
    await expect(stat(destination)).rejects.toThrow();
    cancel = false;
    await open();
    await page.getByRole('menuitem', { name: 'Export logs' }).click();
    await expect(page.getByText('Session log saved', { exact: true })).toBeVisible();
    expect(await readFile(destination, 'utf8')).toBe(ready.expected);
    expect(writes).toBe(1);
    cancel = true;
    await open();
    await page.getByRole('menuitem', { name: 'Export logs' }).click();
    expect(await readFile(destination, 'utf8')).toBe(ready.expected);
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
