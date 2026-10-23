import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { panelPath } from './workspacePanelFiles';

/** One loopback origin per preview; pages cannot read the desktop application's origin. */
export async function createWorkspacePreview(root: string, entry: string) {
  const file = await panelPath(root, entry);
  if (!/\.html?$/i.test(file)) throw new Error('Select an HTML file to preview');
  const directory = path.dirname(file);
  const token = randomBytes(24).toString('hex');
  const prefix = `/${token}/`;
  const mime: Record<string, string> = {
    '.html': 'text/html',
    '.htm': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
  };
  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.host !== `127.0.0.1:${port}` || !['GET', 'HEAD'].includes(req.method ?? '')) {
        res.writeHead(403);
        res.end();
        return;
      }
      const pathname = new URL(req.url!, 'http://127.0.0.1').pathname;
      if (!pathname.startsWith(prefix)) throw new Error('Unknown preview');
      const relative = decodeURIComponent(pathname.slice(prefix.length));
      if (!relative || relative.split(/[\\/]/).some((p) => p === '..' || p.startsWith('.')))
        throw new Error('Invalid preview asset');
      const asset = await panelPath(directory, relative);
      const type = mime[path.extname(asset).toLowerCase()];
      const info = await fs.stat(asset);
      if (!type || !info.isFile() || info.size > 20 * 1024 * 1024)
        throw new Error('Unsupported preview asset');
      const data = await fs.readFile(asset);
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  let port = 0;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}${prefix}${encodeURIComponent(path.basename(file))}`,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}
