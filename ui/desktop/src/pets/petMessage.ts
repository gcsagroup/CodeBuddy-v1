import type { UserInput } from '../types/message';

// Bound the pet's cross-window payload before forwarding it to the normal chat entry.
export function parsePetMessage(value: unknown, allowEmptyDraft = false): UserInput {
  const input = typeof value === 'string' ? { msg: value, images: [] } : value;
  if (!input || typeof input !== 'object') throw new Error('Invalid pet message');
  const { msg, images } = input as UserInput;
  if (typeof msg !== 'string' || msg.length > 8000 || !Array.isArray(images) || images.length > 10)
    throw new Error('Invalid pet message');
  let bytes = 0;
  for (const image of images) {
    if (
      !image ||
      !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mimeType) ||
      typeof image.data !== 'string' ||
      !image.data.length ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)
    )
      throw new Error('Invalid pet image');
    bytes += image.data.length;
    if (bytes > 20 * 1024 * 1024) throw new Error('Pet images too large');
  }
  if (!allowEmptyDraft && !msg.trim() && !images.length) throw new Error('Invalid pet message');
  return { msg: msg.trim(), images };
}

export type PetComposerAction = 'add' | 'agent' | 'goal' | 'plan';
export function parsePetComposerAction(value: unknown): PetComposerAction {
  if (value !== 'add' && value !== 'agent' && value !== 'goal' && value !== 'plan') throw new Error('Invalid pet composer action');
  return value;
}
