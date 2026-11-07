import { fallbackProperties } from './comfyui-fallback.mjs';
import { approvedWorkflow } from './comfyui-workflows.mjs';
import { comfyuiMediaTool } from './comfyui-tool.mjs';
import { workflowParameterProperties } from './comfyui-saved-workflows.mjs';

export const VIDEO_TOOL_NAME = 'generate_video';
function references(input) {
  if (input.mode === 'text_to_video') {
    if (input.image_path || input.reference_images?.length) throw new Error('Reference images require image_to_video or reference_to_video mode');
    return [];
  }
  if (input.mode === 'image_to_video') {
    if (input.reference_images?.length || typeof input.image_path !== 'string' || !input.image_path.trim()) throw new Error('image_to_video requires one workspace image_path');
    return [input.image_path];
  }
  if (input.mode === 'reference_to_video') {
    if (input.image_path || !Array.isArray(input.reference_images) || !input.reference_images.length || input.reference_images.length > 2) throw new Error('reference_to_video requires 1–2 reference_images');
    return input.reference_images;
  }
  throw new Error('Choose text_to_video, image_to_video or reference_to_video');
}
export function comfyVideoWorkflow(input, uploaded, id) {
  references(input);
  return approvedWorkflow(input, uploaded, id, 'video');
}

// Inspect bounded ISO-BMFF boxes before publishing a downloaded MP4 as completed.
// Playback/codec validation is performed by the real player during acceptance.
export function inspectMp4(bytes) {
  function boxes(start, end) {
    const result = [];
    for (let p = start; p < end;) {
      if (p + 8 > end) throw new Error('Truncated MP4 box');
      let size = bytes.readUInt32BE(p), header = 8;
      if (size === 1) {
        if (p + 16 > end) throw new Error('Truncated MP4 extended box');
        size = Number(bytes.readBigUInt64BE(p + 8)); header = 16;
      } else if (size === 0) size = end - p;
      if (!Number.isSafeInteger(size) || size < header || p + size > end) throw new Error('Invalid MP4 box size');
      result.push({ type: bytes.toString('ascii', p + 4, p + 8), start: p + header, end: p + size });
      p += size;
    }
    return result;
  }
  const root = boxes(0, bytes.length);
  const moov = root.find(b => b.type === 'moov');
  if (!root.some(b => b.type === 'ftyp') || !root.some(b => b.type === 'mdat' && b.end > b.start) || !moov)
    throw new Error('ComfyUI did not return a complete MP4');
  for (const trak of boxes(moov.start, moov.end).filter(b => b.type === 'trak')) {
    const children = boxes(trak.start, trak.end);
    const tkhd = children.find(b => b.type === 'tkhd'), mdia = children.find(b => b.type === 'mdia');
    if (!tkhd || !mdia) continue;
    const parts = boxes(mdia.start, mdia.end);
    const handler = parts.find(b => b.type === 'hdlr'), mdhd = parts.find(b => b.type === 'mdhd');
    if (!handler || handler.end - handler.start < 12 || bytes.toString('ascii', handler.start + 8, handler.start + 12) !== 'vide' || !mdhd) continue;
    const v1 = bytes[mdhd.start] === 1;
    if (mdhd.end - mdhd.start < (v1 ? 32 : 20) || tkhd.end - tkhd.start < 84) throw new Error('Truncated MP4 track');
    const timescale = bytes.readUInt32BE(mdhd.start + (v1 ? 20 : 12));
    const duration = v1 ? Number(bytes.readBigUInt64BE(mdhd.start + 24)) : bytes.readUInt32BE(mdhd.start + 16);
    const width = bytes.readUInt32BE(tkhd.end - 8) / 65536, height = bytes.readUInt32BE(tkhd.end - 4) / 65536;
    const duration_seconds = duration / timescale;
    if (!Number.isFinite(duration_seconds) || duration_seconds <= 0 || width <= 0 || height <= 0 || width * height > 1344 * 768)
      throw new Error('Invalid MP4 video dimensions or duration');
    return { width, height, duration_seconds, mime_type: 'video/mp4' };
  }
  throw new Error('MP4 contains no video track');
}

export function comfyuiVideoTool(options) {
  return comfyuiMediaTool(options, {
    name: VIDEO_TOOL_NAME,
    description: 'Generate video / 生视频、文生视频、图生视频 with the configured ComfyUI service. Load the comfyui skill for workflow selection, tunable_parameters and waiting guidance. Inspect saved workflows when tuning is needed; the host selects the file from the current admitted request. Supply the requested mode, prompt and references. Submit once, then wait with the SAME job_id (wait_seconds=240). On waiting_in_background=true, end the turn and tell the user the right-side generation panel will show the result; do not poll again automatically. Returns a real local MP4 with local playback markdown and a remote preview_url; audio depends on the selected workflow. Use the returned markdown verbatim for desktop playback; preview_url is remote source metadata, not the desktop playback link. Never embed MP4 as an image. image_to_video takes one workspace PNG as its first frame; match width/height to its aspect ratio. Honor the user-requested duration_seconds without a fixed application cap; binding depends on the saved graph and its frame-grid rounding. Do not shorten the request or assume published model durations are hard limits. Report server validation or resource errors accurately; never auto-retry by creating another workflow. Never claim success before completed. reference_to_video accepts 1–2 original references. Reuse server-saved workflows; do not substitute a bundled copy. Use operation=inspect and node_types to check available dependencies and schemas. Only if creation_allowed=true may you submit fallback_workflow using installed nodes/models. Never use shell scripts or install/download dependencies. Omitted dimensions/duration preserve the selected template defaults.',
    inputSchema: { type: 'object', properties: {
      operation: { type: 'string', enum: ['inspect', 'generate', 'status', 'cancel'] },
      mode: { type: 'string', enum: ['text_to_video', 'image_to_video', 'reference_to_video'] },
      ...fallbackProperties,
      ...workflowParameterProperties,
      reference_images: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string' }, description: 'Workspace PNG reference images for reference_to_video.' },
      prompt: { type: 'string', minLength: 1, maxLength: 12000, description: 'Describe the scene, motion, camera and desired sound.' },
      image_path: { type: 'string', description: 'Workspace-local PNG first frame, required for image_to_video; omitted for text_to_video.' },
      width: { type: 'integer', minimum: 256, maximum: 1344, multipleOf: 32 },
      height: { type: 'integer', minimum: 256, maximum: 1344, multipleOf: 32 },
      duration_seconds: { type: 'number', exclusiveMinimum: 0, description: 'User-requested duration in seconds, including fractional seconds. No application duration cap. Bind the requested duration to the selected workflow; preserve its frame-grid rounding and fps. Report actual node/model rejection instead of silently shortening or replacing the workflow.' },
      seed: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      request_id: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', description: 'Optional UUID idempotency key. Omit to generate automatically.' },
      job_id: { type: 'string' }, wait_seconds: { type: 'integer', minimum: 0, maximum: 240, description: 'For status: use 240 to wait in the host. Omitted or 0 performs one immediate refresh for compatibility.' },
    }, required: ['operation'], additionalProperties: false },
    workflow: comfyVideoWorkflow, references, inspect: inspectMp4, extension: 'mp4', maxBytes: 128 * 1024 * 1024,
    outputs: save => save?.images ?? save?.gifs ?? save?.videos ?? [],
  });
}
