import { invalid } from './providers.mjs';

export function harnessPrompt(prompt) {
  if (!Array.isArray(prompt) || !prompt.length) throw invalid('A nonempty prompt is required');
  let meaningful = false;
  const parts = prompt.map(part => {
    if (part?.type === 'text' && typeof part.text === 'string') {
      meaningful ||= Boolean(part.text.trim()); return { type: 'text', text: part.text };
    }
    if (part?.type === 'image') {
      if (typeof part.data !== 'string' || !part.data.length || part.data.length > 28 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(part.data) || Buffer.from(part.data, 'base64').toString('base64') !== part.data) throw invalid('Image data must be canonical base64 within 20 MiB');
      if (Buffer.byteLength(part.data, 'base64') > 20 * 1024 * 1024) throw invalid('Image data exceeds 20 MiB');
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(part.mimeType)) throw invalid('Unsupported image format');
      meaningful = true; return { type: 'image', data: part.data, mediaType: part.mimeType };
    }
    if (part?.type === 'resource' && typeof part.resource?.text === 'string') {
      meaningful ||= Boolean(part.resource.text.trim());
      return { type: 'text', text: `Attached resource: ${part.resource.uri ?? ''}\n${part.resource.text}` };
    }
    throw invalid('Unsupported prompt content type');
  });
  if (!meaningful) throw invalid('A nonempty prompt is required');
  return parts;
}
