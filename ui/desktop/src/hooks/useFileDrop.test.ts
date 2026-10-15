import { describe, expect, it } from 'vitest';
import { isSupportedVideoFile } from './useFileDrop';

describe('isSupportedVideoFile', () => {
  it('recognizes browser-decodable video MIME types', () => {
    expect(isSupportedVideoFile({ name: 'demo.mp4', type: 'video/mp4' })).toBe(true);
    expect(isSupportedVideoFile({ name: 'demo.webm', type: 'video/webm' })).toBe(true);
  });

  it('falls back to the extension when Windows omits the MIME type', () => {
    expect(isSupportedVideoFile({ name: 'screen-recording.MOV', type: '' })).toBe(true);
    expect(isSupportedVideoFile({ name: 'requirements.docx', type: '' })).toBe(false);
  });
});
