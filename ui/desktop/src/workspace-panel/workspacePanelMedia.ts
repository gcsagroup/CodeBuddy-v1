import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { panelMedia, panelPath, resolvePanelReference } from './workspacePanelFiles';

export const MEDIA_SCHEME = 'codebuddy-media';

// Only files already inspected through the workspace IPC get a capability URL.
// A renderer reload/window close revokes its capabilities; paths are checked again
// on every request so a replaced junction cannot escape the session workspace.
export class PanelMediaRegistry {
  private grants = new Map<
    string,
    { owner: number; root: string; file: string; referenceFile?: string }
  >();

  grant(owner: number, root: string, file: string, referenceFile?: string): string {
    for (const [token, item] of this.grants)
      if (
        item.owner === owner &&
        item.root === root &&
        item.file === file &&
        item.referenceFile === referenceFile
      )
        return `${MEDIA_SCHEME}://preview/${token}`;
    const token = randomUUID();
    this.grants.set(token, { owner, root, file, referenceFile });
    return `${MEDIA_SCHEME}://preview/${token}`;
  }

  revoke(owner: number) {
    for (const [token, item] of this.grants) if (item.owner === owner) this.grants.delete(token);
  }

  async resolve(url: string) {
    const parsed = new URL(url);
    const item =
      parsed.protocol === `${MEDIA_SCHEME}:` &&
      parsed.host === 'preview' &&
      !parsed.search &&
      !parsed.hash
        ? this.grants.get(parsed.pathname.slice(1))
        : undefined;
    if (!item) throw new Error('Media preview expired');
    const file = item.referenceFile
      ? (await resolvePanelReference(item.root, item.file)).file
      : await panelPath(item.root, item.file);
    if (item.referenceFile && file !== item.referenceFile)
      throw new Error('Media reference changed');
    const stat = await fs.stat(file);
    const media = panelMedia(file, stat.size);
    if (!stat.isFile() || !media) throw new Error('Unsupported media file');
    return { url: pathToFileURL(file).href, mimeType: media.mimeType, size: stat.size };
  }
}

// Electron file fetch honors Range but reports 200 without Content-Range.
// Publish the HTTP range metadata explicitly so Chromium can seek reliably.
export function mediaRange(range: string | null, size: number) {
  if (!range) return { status: 200, start: 0, end: size - 1, length: size };
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2]) || !size) return { status: 416 };
  const first = Number(match[1]),
    last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return { status: 416 };
  const start = match[1] ? first : Math.max(0, size - last);
  const end = match[1] && match[2] ? Math.min(last, size - 1) : size - 1;
  if (start >= size || end < start) return { status: 416 };
  return { status: 206, start, end, length: end - start + 1 };
}
