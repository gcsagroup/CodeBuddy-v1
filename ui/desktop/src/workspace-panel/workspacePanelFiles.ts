import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { PanelDocument, PanelEntry, PanelFileInfo, PanelMedia } from './workspacePanelTypes';

const LIMIT = 2 * 1024 * 1024;
const version = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const writes = new Map<string, Promise<unknown>>();

export function panelMediaType(file: string): PanelMedia | undefined {
  const types: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
  };
  const mimeType = types[path.extname(file).toLowerCase()];
  if (!mimeType) return undefined;
  const kind = mimeType.startsWith('image/') ? 'image' : 'video';
  return { kind, mimeType, url: '' };
}

export function panelMedia(file: string, size: number): PanelMedia | undefined {
  const media = panelMediaType(file);
  if (!media) return undefined;
  const { kind } = media;
  const limit = (kind === 'image' ? 32 : 128) * 1024 * 1024;
  if (size > limit) throw new Error('Media exceeds the preview size limit');
  return media;
}

export function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

export async function panelPath(root: string, requested: string): Promise<string> {
  if (!path.isAbsolute(root) || requested.includes('\0')) throw new Error('Invalid workspace path');
  const realRoot = await fs.realpath(root);
  const file = path.resolve(realRoot, requested);
  if (!inside(realRoot, file)) throw new Error('Path is outside the session workspace');
  // Resolve every access again: junctions can change after a directory was listed.
  const real = await fs.realpath(file);
  if (!inside(realRoot, real)) throw new Error('Link points outside the session workspace');
  return real;
}

// Desktop references authorize this file only, never its containing directory.
export async function resolvePanelReference(root: string, requested: string) {
  if (typeof requested !== 'string' || requested.includes('\0'))
    throw new Error('Invalid reference path');
  const realRoot = await fs.realpath(root);
  const file = await fs.realpath(path.resolve(realRoot, requested));
  const external = !inside(realRoot, file);
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error('Reference must be a regular file');
  const media = panelMedia(file, stat.size);
  const limit = media ? undefined : isPanelDocument(file) ? 32 * 1024 * 1024 : LIMIT;
  if (limit && stat.size > limit) throw new Error('Reference exceeds the preview size limit');
  if ((await fs.realpath(path.resolve(realRoot, requested))) !== file)
    throw new Error('Reference changed; open the link again');
  return { file, external, stat, realRoot };
}

export async function readPanelReference(root: string, requested: string) {
  const { file, external, realRoot } = await resolvePanelReference(root, requested);
  const document = await readPanelFile(
    external ? path.dirname(file) : realRoot,
    external ? path.basename(file) : file
  );
  if (external && document.binary) throw new Error('Unsupported reference format or text encoding');
  if ((await fs.realpath(path.resolve(realRoot, requested))) !== file)
    throw new Error('Reference changed; open the link again');
  if (external) {
    document.path = file;
    document.reference = true;
  }
  return { file, document, external };
}

export async function listPanelFiles(root: string, requested: string) {
  // Resolve the root once so linked workspaces (including macOS /var) keep
  // returned paths in the same coordinate system as the resolved directory.
  const realRoot = await panelPath(root, '');
  const dir = await panelPath(realRoot, requested);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const sorted = entries.sort(
    (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)
  );
  return {
    entries: sorted.slice(0, 2000).map(
      (e) =>
        ({
          name: e.name,
          path: path.relative(realRoot, path.join(dir, e.name)),
          kind: e.isSymbolicLink() ? 'link' : e.isDirectory() ? 'directory' : 'file',
        }) as PanelEntry
    ),
    truncated: entries.length > 2000,
  };
}

const externalDocuments = new Set(['.docx', '.xlsx', '.pptx', '.pdf']);
// These file types can be handed to the user's default application only after
// an explicit desktop open action; preview itself never launches an application.
const externalText = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.log',
  '.csv',
]);
const editorText = new Set([
  '.py',
  '.pyw',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ps1',
  '.sh',
  '.bash',
  '.bat',
  '.cmd',
  '.vbs',
  '.rb',
  '.pl',
  '.ts',
  '.tsx',
  '.rs',
  '.go',
  '.java',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.css',
  '.scss',
  '.vue',
]);

export function isPanelEditorFile(file: string): boolean {
  const extension = path.extname(file).toLowerCase();
  return editorText.has(extension);
}

export function canOpenPanelFileExternally(file: string): boolean {
  const extension = path.extname(file).toLowerCase();
  return (
    externalDocuments.has(extension) ||
    externalText.has(extension) ||
    isPanelEditorFile(file) ||
    !!panelMediaType(file)
  );
}

export function isPanelDocument(file: string): boolean {
  return externalDocuments.has(path.extname(file).toLowerCase());
}

export async function inspectPanelFile(
  root: string,
  requested: string,
  reference = false
): Promise<PanelFileInfo> {
  const realRoot = await fs.realpath(root);
  const file = reference
    ? (await resolvePanelReference(realRoot, requested)).file
    : await panelPath(realRoot, requested);
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error('Path is not a regular file');
  return {
    path: inside(realRoot, file) ? path.relative(realRoot, file) : file,
    ...(!inside(realRoot, file) ? { reference: true } : {}),
    size: stat.size,
    openExternally: externalDocuments.has(path.extname(file).toLowerCase()),
    media: panelMedia(file, stat.size),
  };
}

export async function externalPanelFile(root: string, requested: string): Promise<string> {
  const file = await panelPath(root, requested);
  const stat = await fs.stat(file);
  if (!stat.isFile() || !canOpenPanelFileExternally(file))
    throw new Error(
      'This file type cannot be opened safely through its OS association. Preview it in CodeBuddy instead.'
    );
  return file;
}

export async function searchPanelFiles(root: string, query: string) {
  const results: PanelEntry[] = [];
  const queue = [''];
  let visited = 0;
  const q = query.trim().toLocaleLowerCase();
  if (!q) return { entries: results, truncated: false };
  while (queue.length && visited < 10000 && results.length < 200) {
    const relative = queue.shift()!;
    const { entries } = await listPanelFiles(root, relative);
    for (const entry of entries) {
      visited++;
      if (entry.path.toLocaleLowerCase().includes(q)) results.push(entry);
      if (
        entry.kind === 'directory' &&
        !['.git', 'node_modules', 'target', '.venv'].includes(entry.name)
      )
        queue.push(entry.path);
      if (visited >= 10000 || results.length >= 200) break;
    }
  }
  return { entries: results.slice(0, 200), truncated: visited >= 10000 || results.length >= 200 };
}

function decodeText(data: Buffer): string | null {
  const bom = data.subarray(0, 2).toString('hex');
  const encoding = bom === 'fffe' ? 'utf-16le' : bom === 'feff' ? 'utf-16be' : 'utf-8';
  try {
    const text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(data);
    return text.includes('\0') ? null : text;
  } catch {
    return null;
  }
}

export async function readPanelFile(root: string, requested: string): Promise<PanelDocument> {
  const file = await panelPath(root, requested);
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error('Path is not a regular file');
  const media = panelMedia(file, stat.size);
  if (media) return { path: requested, content: '', version: '', media };
  if (!stat.isFile() || stat.size > LIMIT) throw new Error('Preview supports files up to 2 MB');
  const data = await fs.readFile(file);
  if (data.length > LIMIT) throw new Error('File grew beyond the preview limit');
  const content = decodeText(data);
  return content === null
    ? { path: requested, content: '', version: version(data), binary: true }
    : { path: requested, content, version: version(data) };
}

export async function savePanelFile(
  root: string,
  requested: string,
  content: string,
  expected: string
): Promise<PanelDocument> {
  if (Buffer.byteLength(content, 'utf8') > LIMIT)
    throw new Error('File exceeds the 2 MB editing limit');
  const file = await panelPath(root, requested);
  if (panelMedia(file, 0)) throw new Error('Media files are read-only');
  const previous = writes.get(file) ?? Promise.resolve();
  const operation = previous
    .catch(() => {})
    .then(async () => {
      // One handle binds the comparison and write to the same file, without following a swapped link.
      const handle = await fs.open(await panelPath(root, requested), 'r+');
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > LIMIT) throw new Error('Invalid text file');
        const current = await handle.readFile();
        if (version(current) !== expected)
          throw new Error(
            'File changed on disk. Reload it before saving; your edits have been kept.'
          );
        if (decodeText(current) === null || content.includes('\0'))
          throw new Error('Binary files are read-only');
        const bom = current.subarray(0, 2).toString('hex');
        const utf16 = bom === 'fffe' || bom === 'feff';
        const savedContent = utf16 && !content.startsWith('\ufeff') ? '\ufeff' + content : content;
        const bytes = Buffer.from(savedContent, utf16 ? 'utf16le' : 'utf8');
        if (bom === 'feff') bytes.swap16();
        if (bytes.length > LIMIT) throw new Error('File exceeds the 2 MB editing limit');
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
          if (!bytesWritten) throw new Error('File write made no progress');
          offset += bytesWritten;
        }
        await handle.truncate(bytes.length);
        await handle.sync();
        return { path: requested, content: savedContent, version: version(bytes) };
      } finally {
        await handle.close();
      }
    });
  writes.set(file, operation);
  try {
    return await operation;
  } finally {
    if (writes.get(file) === operation) writes.delete(file);
  }
}

export function panelUrl(value: string): string {
  const trimmed = value.trim();
  const withScheme =
    /^[a-z][a-z\d+.-]*:/i.test(trimmed) && !/^localhost:\d/i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
  const url = new URL(withScheme);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Use an HTTP or HTTPS address without embedded credentials');
  return url.toString();
}
