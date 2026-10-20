import { expect, it } from 'vitest';
import { generatedMediaPaths } from './GeneratedMedia';
import type { ToolResponseMessageContent } from '../types/message';

it('uses completed image/video receipts, including persisted text receipts, without trusting prose or URLs', () => {
  const receipt = {
    status: 'completed',
    videos: [{ path: 'generated-videos/1.mp4', preview_url: 'http://server/view' }],
  };
  const response: ToolResponseMessageContent = {
    type: 'toolResponse',
    id: 'one',
    toolResult: {
      status: 'success',
      value: { content: [{ type: 'text', text: JSON.stringify(receipt) }] },
    },
  };
  expect(generatedMediaPaths('generate_video', response)).toEqual(['generated-videos/1.mp4']);
  expect(generatedMediaPaths('pwsh', response)).toEqual([]);
  response.toolResult.value = { structuredContent: { ...receipt, status: 'running' } };
  expect(generatedMediaPaths('generate_video', response)).toEqual([]);
  response.toolResult.value = {
    structuredContent: { status: 'completed', images: [{ path: 'photo.png' }] },
  };
  expect(generatedMediaPaths('generate_image', response)).toEqual(['photo.png']);
  response.toolResult.value = { isError: true, structuredContent: receipt };
  expect(generatedMediaPaths('generate_video', response)).toEqual([]);
});
