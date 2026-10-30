import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { DraftRequest, DraftSnapshot, NewTaskDraft } from './types';

const image = z.object({
  id: z.string(),
  dataUrl: z.string(),
  isLoading: z.boolean(),
  error: z.string().optional(),
});
const file = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  type: z.string(),
  isImage: z.boolean(),
  isVideo: z.boolean(),
  dataUrl: z.string().optional(),
  frameDataUrls: z.array(z.string()).optional(),
  isLoading: z.boolean().optional(),
  error: z.string().optional(),
});
const draft = z.object({
  permissionPreset: z.enum(['read-only', 'workspace-write', 'danger-full-access']).nullable().optional(),
  text: z.string().optional(),
  workingDir: z.string().optional(),
  images: z.array(image).optional(),
  files: z.array(file).optional(),
});
const key = z.enum(['code', 'codepro']);
const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read') }),
  z.object({ action: z.literal('update'), key, patch: draft }),
  z.object({ action: z.literal('clear'), key }),
]);

// The main process owns disk writes. Window slots survive a process restart;
// live windows never claim the same slot, including after renderer reloads.
export class DraftStore {
  private slots = new Map<number, number>();
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly root: string) {}

  release(owner: number) {
    this.slots.delete(owner);
  }
  flush() {
    return this.pending;
  }
  request(owner: number, input: DraftRequest): Promise<DraftSnapshot> {
    const parsed = requestSchema.parse(input);
    if (!this.slots.has(owner)) {
      let slot = 1;
      while ([...this.slots.values()].includes(slot)) slot++;
      this.slots.set(owner, slot);
    }
    const directory = path.join(this.root, `window-${this.slots.get(owner)}`);
    const operation = this.pending.then(() => this.execute(directory, parsed));
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  private async load(directory: string): Promise<NewTaskDraft> {
    const result: NewTaskDraft = {};
    for (const field of ['text', 'workingDir', 'images', 'files', 'permissionPreset'] as const) {
      try {
        const value = JSON.parse(await readFile(path.join(directory, `${field}.json`), 'utf8'));
        Object.assign(result, draft.parse({ [field]: value }));
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') throw error;
      }
    }
    // A process may close while a preview is decoding. Never restore a spinner
    // that has no running reader behind it.
    for (const attachment of [...(result.images ?? []), ...(result.files ?? [])]) {
      if (attachment.isLoading) {
        attachment.isLoading = false;
        attachment.error = 'Attachment processing was interrupted. Remove it and attach it again.';
      }
    }
    for (const attachment of result.files ?? []) {
      if (attachment.error || !attachment.path) continue;
      try {
        await stat(attachment.path);
      } catch {
        attachment.error = 'Saved attachment is missing. Remove it and attach it again.';
      }
    }
    return result;
  }

  private async atomicWrite(filename: string, value: unknown) {
    await mkdir(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.tmp`;
    await writeFile(temporary, JSON.stringify(value), 'utf8');
    await rename(temporary, filename);
  }

  private async execute(directory: string, request: DraftRequest): Promise<DraftSnapshot> {
    if (request.action === 'read') {
      return {
        code: await this.load(path.join(directory, 'code')),
        codepro: await this.load(path.join(directory, 'codepro')),
      };
    }
    const modeDirectory = path.join(directory, request.key);
    const patch: NewTaskDraft =
      request.action === 'clear'
        ? { text: '', workingDir: '', images: [], files: [], permissionPreset: null }
        : request.patch;
    if (patch.files) {
      patch.files = await Promise.all(
        patch.files.map(async (attachment) => {
          if (attachment.error || !attachment.path) return attachment;
          const identity = createHash('sha256').update(attachment.id).digest('hex');
          const target = path.join(
            modeDirectory,
            'attachments',
            identity,
            path.basename(attachment.path)
          );
          if (path.resolve(attachment.path) !== path.resolve(target)) {
            try {
              await stat(target);
            } catch (error) {
              if ((error as { code?: string }).code !== 'ENOENT') throw error;
              const source = await stat(attachment.path);
              if (!source.isFile() || source.size > 200 * 1024 * 1024)
                throw new Error('Attachment must be a file of at most 200 MB');
              await mkdir(path.dirname(target), { recursive: true });
              await copyFile(attachment.path, `${target}.tmp`);
              await rename(`${target}.tmp`, target);
            }
          }
          return { ...attachment, path: target };
        })
      );
    }
    // Separate fields keep typing cheap: a text edit never serializes image
    // content or copies files again. Copies remain valid for sent history.
    for (const [field, value] of Object.entries(patch)) {
      await this.atomicWrite(path.join(modeDirectory, `${field}.json`), value);
    }
    return patch.files ? { [request.key]: { files: patch.files } } : {};
  }
}
