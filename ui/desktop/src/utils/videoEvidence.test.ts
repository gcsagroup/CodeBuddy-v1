import { describe, expect, it } from 'vitest';
import type { DroppedFile } from '../hooks/useFileDrop';
import { videoEvidenceContext, videoSampleTimes } from './videoEvidence';

const image = 'data:image/jpeg;base64,YQ==';
const video: DroppedFile = {
  id: 'v',
  name: 'clip.mp4',
  path: '/clip.mp4',
  type: 'video/mp4',
  isImage: false,
  isVideo: true,
  frameDataUrls: [image, image],
  videoSample: { durationSeconds: 10, timestampsSeconds: [0.25, 9.75] },
};
const evidence = (files: DroppedFile[]) =>
  JSON.parse(videoEvidenceContext(files, 1).split('\n')[3]);

describe('video observation evidence', () => {
  it('includes opening and ending, bounds samples and handles very short clips', () => {
    const times = videoSampleTimes(3600);
    expect(times).toHaveLength(6);
    expect(times[0]).toBeLessThan(1);
    expect(times[times.length - 1]).toBeGreaterThan(3599);
    expect(videoSampleTimes(0.01)).toEqual([0.005]);
    for (const duration of [0.01, 1, 2, 3, 60, 3600]) {
      const samples = videoSampleTimes(duration);
      expect(new Set(samples).size).toBe(samples.length);
      expect(samples.every((time) => time > 0 && time < duration)).toBe(true);
    }
    expect(() => videoSampleTimes(Infinity)).toThrow();
  });
  it('matches attached image order across mixed files and preserves repeated-frame timestamps', () => {
    const results = evidence([
      { ...video, isVideo: false, isImage: true, frameDataUrls: undefined, dataUrl: image },
      { ...video, isLoading: true },
      video,
      { ...video, error: 'decode failed' },
      video,
    ]);
    expect(results).toHaveLength(2);
    expect(results[0].frames).toEqual([
      { imageNumber: 3, timestamp: '0:00.250' },
      { imageNumber: 4, timestamp: '0:09.750' },
    ]);
    expect(results[1].frames[0].imageNumber).toBe(5);
    expect(results[0]).toMatchObject({
      audioAnalyzed: false,
      subtitlesAnalyzed: false,
      coverage: 'sampled_still_images_only',
    });
  });
  it('keeps old drafts usable without inventing timestamps or coverage', () => {
    const result = evidence([{ ...video, videoSample: undefined }])[0];
    expect(result.durationSeconds).toBeNull();
    expect(result.frames.every((frame: { timestamp: unknown }) => frame.timestamp === null)).toBe(
      true
    );
    expect(videoEvidenceContext([{ ...video, error: 'failed' }], 0)).toBe('');
  });
});
