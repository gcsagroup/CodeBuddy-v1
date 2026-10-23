import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkspacePreview } from './workspacePreview';
it('serves HTML and sibling assets, rejects private files/traversal and closes the origin', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codebuddy-preview-test-'));
  let preview: Awaited<ReturnType<typeof createWorkspacePreview>> | undefined;
  try {
    await fs.writeFile(path.join(root, 'index.html'), '<h1>预览</h1>');
    await fs.writeFile(path.join(root, 'style.css'), 'body {color:red}');
    await fs.writeFile(path.join(root, '.env'), 'PRIVATE');
    preview = await createWorkspacePreview(root, 'index.html');
    expect(await (await fetch(preview.url)).text()).toContain('预览');
    expect((await fetch(new URL('style.css', preview.url))).status).toBe(200);
    for (const relative of ['.env', '../index.html', '%2e%2e%5cindex.html', '/index.html'])
      expect((await fetch(new URL(relative, preview.url))).status).toBe(404);
    expect((await fetch(preview.url, { method: 'POST' })).status).toBe(403);
    await expect(createWorkspacePreview(root, '../else.html')).rejects.toThrow();
    preview.close();
    await expect(fetch(preview.url)).rejects.toThrow();
  } finally {
    preview?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
