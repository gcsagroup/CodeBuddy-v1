import { describe, expect, it } from 'vitest';
import { parsePetMessage, parsePetComposerAction } from './petMessage';

describe('pet message transport', () => {
  const image = { mimeType: 'image/png', data: 'eA==' };
  it('accepts legacy text and image-only input without inventing a prompt', () => {
    expect(parsePetMessage(' hi ')).toEqual({ msg: 'hi', images: [] });
    expect(parsePetMessage({ msg: '', images: [image] })).toEqual({ msg: '', images: [image] });
  });
  it('rejects empty, excessive and malformed payloads before starting a chat', () => {
    for (const input of [
      '',
      null,
      { msg: 'x'.repeat(8001), images: [] },
      { msg: '', images: Array(11).fill(image) },
      { msg: '', images: [{ ...image, mimeType: 'text/html' }] },
      { msg: '', images: [{ ...image, data: 'invalid%' }] },
      { msg: '', images: [{ ...image, data: 'a'.repeat(20 * 1024 * 1024 + 1) }] },
    ])
      expect(() => parsePetMessage(input)).toThrow();
  });
});

it('allows an empty picker draft but not an empty submission, and validates picker actions', () => {
  expect(parsePetMessage({ msg: '', images: [] }, true)).toEqual({ msg: '', images: [] });
  expect(() => parsePetMessage({ msg: '', images: [] })).toThrow();
  expect(parsePetComposerAction('add')).toBe('add');
  expect(parsePetComposerAction('agent')).toBe('agent');
  expect(() => parsePetComposerAction('send')).toThrow();
});
