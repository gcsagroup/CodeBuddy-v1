import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export function videoDuration(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw new Error('duration_seconds must be a finite positive number');
  return value;
}

// User-exported graphs are immutable templates. Only the named scalar slots below
// are writable. Conditional fallback graphs are checked separately against the server inventory.
const definitions = {
  qwen_image: ['QI2.1_t2i1.json', 'text_to_image', 'Qwen · 文生图', '459:452', 'prompt', '459:458', 'seed', '13', '461', []],
  qwen_edit: ['QI2.1_i2i.json', 'image_to_image', 'Qwen · 参考图编辑', '459:474', 'prompt', '459:458', 'seed', '13', '461', ['470', '475']],
  minimax_text: ['video_minimax_h3_t2v (1).json', 'text_to_video', 'MiniMax · 文生视频', '143', 'value', '140:129', 'noise_seed', '115', '92', [], '140:133'],
  minimax_text_detail: ['TextToVideo.json', 'text_to_video', 'MiniMax · 文生视频 0.9 MP', '143', 'value', '140:129', 'noise_seed', '115', '92', [], '140:133'],
  minimax_image: ['video_minimax_h3_i2v.json', 'image_to_video', 'MiniMax · 首帧生视频', '105:104', 'prompt', '105:15', 'noise_seed', '115', '92', ['114'], '105:111'],
  minimax_reference: ['video_minimax_h3_r2v.json', 'reference_to_video', 'MiniMax · 参考图生视频', '138', 'value', '129', 'noise_seed', '115', '92', ['137', '139'], '132'],
};
const templates = Object.fromEntries(Object.entries(definitions).map(([id, definition]) => {
  const [file, mode, label, promptNode, promptKey, seedNode, seedKey, resolutionNode, saveNode, referenceNodes, durationNode] = definition;
  const bytes = readFileSync(new URL(`./assets/comfyui/${encodeURIComponent(file)}`, import.meta.url));
  return [id, { id, file, mode, label, promptNode, promptKey, seedNode, seedKey, resolutionNode, saveNode, referenceNodes, durationNode,
    sha256: createHash('sha256').update(bytes).digest('hex'), graph: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) }];
}));
const imageIds = ['qwen_image', 'qwen_edit'];
export const IMAGE_WORKFLOWS = imageIds;
export const VIDEO_WORKFLOWS = Object.keys(templates).filter(id => !imageIds.includes(id));
export function workflowCandidates(kind, mode, referenceCount) {
  const wanted = kind === 'image' ? (referenceCount ? 'image_to_image' : 'text_to_image') : mode;
  return Object.values(templates).filter(spec => spec.mode === wanted).map(spec => structuredClone(spec));
}
const allowed = new Set(['operation', 'workflow_name', 'workflow_id', 'mode', 'prompt', 'reference_images', 'image_path', 'transparent_background', 'width', 'height', 'duration_seconds', 'seed', 'request_id', 'job_id', 'wait_seconds', 'fallback_workflow', 'node_types', 'node_offset', 'workflow_parameters']);
export function validateWorkflowInput(input) {
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`Unsupported parameter: ${key}. Use workflow_name, or inspect before supplying fallback_workflow.`);
}
function integer(value, min, max, multiple = 1) {
  if (!Number.isSafeInteger(value) || value < min || value > max || value % multiple)
    throw new Error(`Expected an integer ${min}..${max}, multiple of ${multiple}`);
  return value;
}
export function workflowSpec(input, kind, referenceCount) {
  validateWorkflowInput(input);
  const mode = kind === 'image' ? (referenceCount ? 'image_to_image' : 'text_to_image') : input.mode;
  const defaults = { text_to_image: 'qwen_image', image_to_image: 'qwen_edit', text_to_video: 'minimax_text', image_to_video: 'minimax_image', reference_to_video: 'minimax_reference' };
  const spec = templates[input.workflow_id ?? defaults[mode]];
  if (!spec || spec.mode !== mode) throw new Error('Choose an approved workflow matching the mode and reference images');
  if ((spec.referenceNodes.length > 0) !== (referenceCount > 0) || referenceCount > spec.referenceNodes.length)
    throw new Error('Reference images do not match the selected workflow');
  return spec;
}
const stageClasses = {
  UNETLoader: 'model', CLIPLoader: 'clip', TextEncodeQwenImage21: 'encode', MiniMaxH3ImageToVideo: 'encode', MiniMaxH3ReferenceToVideo: 'encode',
  KSampler: 'sample', SamplerCustomAdvanced: 'sample', VAEDecode: 'decode', VAEDecodeTiled: 'decode', VAEDecodeAudio: 'audio', CreateVideo: 'video', SaveVideo: 'save', SaveImageAdvanced: 'save', LoadImage: 'reference',
};
export function workflowMetadata(input, kind, referenceCount) {
  const spec = workflowSpec(input, kind, referenceCount);
  return { id: spec.id, label: spec.label, source: spec.file, sha256: spec.sha256, save_node: spec.saveNode,
    stages: Object.fromEntries(Object.entries(spec.graph).map(([id, node]) => [id, stageClasses[node.class_type] ?? 'prepare'])) };
}
export function approvedWorkflow(input, references, id, kind) {
  const spec = workflowSpec(input, kind, references.length);
  const graph = structuredClone(spec.graph);
  const slot = (node, field, value) => { graph[node].inputs[field] = value; };
  const prompt = input.transparent_background
    ? `${input.prompt}\nTransparent background with an alpha channel. No background or ground shadow.` : input.prompt;
  slot(spec.promptNode, spec.promptKey, prompt);
  slot(spec.seedNode, spec.seedKey, integer(input.seed ?? Math.floor(Math.random() * 2 ** 48), 0, Number.MAX_SAFE_INTEGER));
  slot(spec.saveNode, 'filename_prefix', `CodeBuddy/${id}`);
  // The supplied edit/reference graphs have two image slots. With one reference,
  // bind both to that same real image, never leave the template's sample image.
  spec.referenceNodes.forEach((node, i) => slot(node, 'image', references[i] ?? references[0]));
  if (input.duration_seconds !== undefined) {
    if (!spec.durationNode) throw new Error('duration_seconds requires a video workflow');
    slot(spec.durationNode, 'value', videoDuration(input.duration_seconds));
  }
  if (input.width !== undefined || input.height !== undefined) {
    const limit = kind === 'image' ? 2048 : 1344;
    const width = integer(input.width ?? 1024, 256, limit, 32);
    const height = integer(input.height ?? 1024, 256, limit, 32);
    if (kind === 'video' && width * height > 1344 * 768) throw new Error('Video resolution exceeds 1344×768 pixels');
    const ratios = [[1,1,'Square'],[2,3,'Portrait Photo'],[3,2,'Photo'],[3,4,'Portrait Standard'],[4,3,'Standard'],[9,16,'Portrait Widescreen'],[16,9,'Widescreen'],[21,9,'Ultrawide']];
    const ratio = ratios.find(([w,h]) => width * h === height * w);
    if (!ratio) throw new Error('The approved workflow supports aspect ratios 1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9, 21:9');
    slot(spec.resolutionNode, 'aspect_ratio', `${ratio[0]}:${ratio[1]} (${ratio[2]})`);
    const megapixels = width * height / 1024 ** 2;
    if (megapixels < 0.1) throw new Error('The approved resolution selector requires at least 0.1 megapixels');
    slot(spec.resolutionNode, 'megapixels', megapixels);
    slot(spec.resolutionNode, 'multiple', 32);
    if (spec.id === 'qwen_edit') slot('459:468', 'switch', true);
  }
  return graph;
}
