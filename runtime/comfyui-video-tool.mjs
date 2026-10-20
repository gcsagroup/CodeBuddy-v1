import { comfyuiMediaTool } from './comfyui-tool.mjs';

export const VIDEO_TOOL_NAME = 'generate_video';
const node = (class_type, inputs) => ({ class_type, inputs });
function number(value, fallback, min, max, multiple = 1) {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < min || n > max || n % multiple)
    throw new Error(`Expected an integer ${min}..${max}, multiple of ${multiple}`);
  return n;
}
function references(input) {
  if (!['text_to_video', 'image_to_video'].includes(input.mode)) throw new Error('Choose text_to_video or image_to_video');
  if (input.mode === 'text_to_video') {
    if (input.image_path) throw new Error('image_path requires image_to_video mode');
    return [];
  }
  if (typeof input.image_path !== 'string' || !input.image_path.trim()) throw new Error('image_to_video requires a workspace PNG image_path');
  return [input.image_path];
}

// Native H3 graph, independently assembled against the official node schemas.
// No API-credit nodes, third-party extensions or optional LoRA downloads.
export function comfyVideoWorkflow(input, uploaded, id) {
  references(input);
  const width = number(input.width, 640, 256, 1344, 32);
  const height = number(input.height, 640, 256, 1344, 32);
  if (width * height > 1344 * 768) throw new Error('Video resolution exceeds 1344×768 pixels');
  const seconds = number(input.duration_seconds, 5, 5, 15);
  const length = Math.ceil((seconds * 24 - 5) / 17) * 17 + 5;
  const graph = {
    model: node('UNETLoader', { unet_name: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors', weight_dtype: 'default' }),
    clip: node('CLIPLoader', { clip_name: 'qwen3vl_32b_minimax_h3_int8_convrot.safetensors', type: 'minimax', device: 'default' }),
    vae: node('VAELoader', { vae_name: 'minimax_h3_video_vae_fp16.safetensors' }),
    audio_vae: node('VAELoader', { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' }),
    encode: node('MiniMaxH3ImageToVideo', { clip: ['clip', 0], vae: ['vae', 0], prompt: input.prompt, width, height, length }),
    noise: node('RandomNoise', { noise_seed: number(input.seed, Math.floor(Math.random() * 2 ** 48), 0, Number.MAX_SAFE_INTEGER) }),
    guider: node('BasicGuider', { model: ['model', 0], conditioning: ['encode', 0] }),
    sampler: node('KSamplerSelect', { sampler_name: 'res_multistep' }),
    schedule: node('BasicScheduler', { model: ['model', 0], scheduler: 'simple', steps: 20, denoise: 1 }),
    sample: node('SamplerCustomAdvanced', { noise: ['noise', 0], guider: ['guider', 0], sampler: ['sampler', 0], sigmas: ['schedule', 0], latent_image: ['encode', 1] }),
    decode: node('VAEDecodeTiled', { samples: ['sample', 0], vae: ['vae', 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 }),
    audio: node('VAEDecodeAudio', { samples: ['sample', 0], vae: ['audio_vae', 0] }),
    video: node('CreateVideo', { images: ['decode', 0], audio: ['audio', 0], fps: 24 }),
    save: node('SaveVideo', { video: ['video', 0], filename_prefix: `CodeBuddy/${id}`, format: 'mp4', 'format.codec': 'h264' }),
  };
  if (uploaded.length) {
    graph.reference = node('LoadImage', { image: uploaded[0] });
    graph.encode.inputs.first_frame = ['reference', 0];
  }
  return graph;
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
    if (!Number.isFinite(duration_seconds) || duration_seconds <= 0 || duration_seconds > 20 || width <= 0 || height <= 0 || width * height > 1344 * 768)
      throw new Error('Invalid MP4 video dimensions or duration');
    return { width, height, duration_seconds, mime_type: 'video/mp4' };
  }
  throw new Error('MP4 contains no video track');
}

export function comfyuiVideoTool(options) {
  return comfyuiMediaTool(options, {
    name: VIDEO_TOOL_NAME,
    description: 'Generate video / 生视频、文生视频、图生视频 with the configured ComfyUI MiniMax H3 service. Submit once, then poll status with the SAME job_id (wait_seconds=30) until completed. Returns a real local MP4 with audio and a playable preview_url. Include the returned markdown link plus local path in your reply; never embed MP4 as an image. image_to_video takes one workspace PNG as its first frame; match width/height to its aspect ratio. 5–15 seconds, 24 fps, duration rounded to the model frame grid. Never claim success before completed. Do not write shell generation scripts.',
    inputSchema: { type: 'object', properties: {
      operation: { type: 'string', enum: ['generate', 'status', 'cancel'] },
      mode: { type: 'string', enum: ['text_to_video', 'image_to_video'] },
      prompt: { type: 'string', minLength: 1, maxLength: 12000, description: 'Describe the scene, motion, camera and desired sound.' },
      image_path: { type: 'string', description: 'Workspace-local PNG first frame, required for image_to_video; omitted for text_to_video.' },
      width: { type: 'integer', minimum: 256, maximum: 1344, multipleOf: 32 },
      height: { type: 'integer', minimum: 256, maximum: 1344, multipleOf: 32 },
      duration_seconds: { type: 'integer', minimum: 5, maximum: 15 },
      seed: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      request_id: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', description: 'Optional UUID idempotency key. Omit to generate automatically.' },
      job_id: { type: 'string' }, wait_seconds: { type: 'integer', minimum: 0, maximum: 30 },
    }, required: ['operation'], additionalProperties: false },
    workflow: comfyVideoWorkflow, references, inspect: inspectMp4, extension: 'mp4', maxBytes: 128 * 1024 * 1024,
    outputs: save => save?.images ?? save?.gifs ?? save?.videos ?? [],
  });
}
