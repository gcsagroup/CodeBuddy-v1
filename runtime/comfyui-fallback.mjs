import { createHash } from 'node:crypto';
import { workflowCandidates } from './comfyui-workflows.mjs';

export const fallbackProperties = {
  node_types: { type: 'array', maxItems: 24, items: { type: 'string' }, description: 'For inspect: request installed node schemas needed to compose a fallback.' },
  node_offset: { type: 'integer', minimum: 0, description: 'For inspect: paginate installed node names using next_node_offset.' },
  fallback_workflow: { type: 'object', additionalProperties: true, description: 'ComfyUI API graph, allowed ONLY when inspect reports creation_allowed=true. Use $prompt and $reference:0 / $reference:1 in LoadImage.image. Bind supplied width, height, seed, duration_seconds with $width, $height, $seed, $duration_seconds respectively (duration in seconds, not frames). Otherwise use graph defaults. Use exactly one SaveImage, SaveImageAdvanced (PNG) or SaveVideo (MP4) output. No model downloads, installs or shell scripts. Host rechecks availability on submission.' },
};
const record = value => value && typeof value === 'object' && !Array.isArray(value);
export function validateNodeInventory(info) {
  if (!record(info) || Object.keys(info).length === 0 || Object.values(info).some(node => !record(node) || !record(node.input) || !Array.isArray(node.output)))
    throw new Error('ComfyUI node inventory is unavailable or invalid; workflow creation is not enabled');
  return info;
}
function choices(schema) {
  if (Array.isArray(schema?.[0])) return schema[0];
  if (schema?.[0] === 'COMBO' && Array.isArray(schema[1]?.options)) return schema[1].options;
  return undefined;
}
function missingDependencies(graph, info) {
  const missing = [];
  for (const [id, node] of Object.entries(graph)) {
    const definition = info[node.class_type];
    if (!definition) { missing.push({ node: id, type: 'node', name: node.class_type }); continue; }
    // These are provider-defined enum values, not guesses from prompt text.
    // Dynamic widgets and uploaded images are validated by ComfyUI at submission.
    for (const [key, value] of Object.entries(node.inputs)) {
      if (key === 'image' || Array.isArray(value)) continue;
      const options = choices(definition.input.required?.[key] ?? definition.input.optional?.[key]);
      if (options?.every(item => ['string', 'number', 'boolean'].includes(typeof item)) && !options.includes(value))
        missing.push({ node: id, type: 'selection', field: key, value });
    }
  }
  return missing;
}
export function inspectWorkflows(info, kind, mode, referenceCount, nodeTypes = [], nodeOffset = 0) {
  validateNodeInventory(info);
  if (!Number.isSafeInteger(nodeOffset) || nodeOffset < 0) throw new Error('node_offset must be a nonnegative integer');
  if (kind === 'image' && mode !== undefined && !['text_to_image', 'image_to_image'].includes(mode)) throw new Error('Choose text_to_image or image_to_image');
  if (!Array.isArray(nodeTypes) || nodeTypes.length > 24 || nodeTypes.some(type => typeof type !== 'string')) throw new Error('node_types must contain up to 24 node names');
  const candidates = workflowCandidates(kind, mode, referenceCount);
  if (!candidates.length) throw new Error('Choose a supported generation mode before inspecting workflows');
  const workflows = candidates.map(spec => {
    const missing = missingDependencies(spec.graph, info);
    return { id: spec.id, label: spec.label, dependencies_available: !missing.length, missing };
  });
  const creationAllowed = !workflows.some(item => item.dependencies_available);
  return {
    workflows, creation_allowed: creationAllowed,
    note: 'Dependency availability is not proof of successful generation. Network errors and runtime failures do not authorize replacement graphs. This catalog covers workflows registered in CodeBuddy; import user-exported workflows before using them.',
    node_count: Object.keys(info).length,
    node_types: Object.keys(info).sort().slice(nodeOffset, nodeOffset + 300),
    next_node_offset: nodeOffset + 300 < Object.keys(info).length ? nodeOffset + 300 : null,
    schemas: Object.fromEntries(nodeTypes.map(type => [type, info[type] ?? null])),
  };
}
export function prepareFallback(input, kind, references, id, info) {
  const catalog = inspectWorkflows(info, kind, input.mode, references.length);
  if (!catalog.creation_allowed) throw new Error('An existing workflow has available dependencies. Reuse it; fallback creation is disabled.');
  if (input.workflow_id) throw new Error('Choose either workflow_id or fallback_workflow');
  const source = input.fallback_workflow;
  if (!record(source) || !Object.keys(source).length || Object.keys(source).length > 128 || Buffer.byteLength(JSON.stringify(source)) > 128 * 1024)
    throw new Error('fallback_workflow must be an API graph of 1–128 nodes, under 128 KiB');
  const parameters = {};
  for (const key of ['width', 'height', 'seed', 'duration_seconds']) {
    if (input[key] === undefined) continue;
    const min = key === 'seed' ? 0 : key === 'duration_seconds' ? 1 : 256;
    const max = key === 'seed' ? Number.MAX_SAFE_INTEGER : key === 'duration_seconds' ? 15 : kind === 'image' ? 2048 : 1344;
    if (!Number.isSafeInteger(input[key]) || input[key] < min || input[key] > max || (['width', 'height'].includes(key) && input[key] % 32)) throw new Error(`Invalid fallback parameter: ${key}`);
    if (key === 'duration_seconds' && kind !== 'video') throw new Error('duration_seconds requires video');
    parameters[`$${key}`] = input[key];
  }
  const graph = structuredClone(source), outputs = [], usedReferences = new Set(), boundParameters = new Set();
  let prompts = 0;
  for (const [nodeId, node] of Object.entries(graph)) {
    if (!record(node) || typeof node.class_type !== 'string' || !record(node.inputs) || !info[node.class_type]) throw new Error(`Unknown or invalid node: ${nodeId}`);
    const definition = info[node.class_type];
    if (definition.api_node) throw new Error('Fallback workflows use locally installed models, not external paid API nodes');
    if (definition.output_node) {
      const supported = kind === 'image' ? ['SaveImage', 'SaveImageAdvanced'] : ['SaveVideo'];
      if (!supported.includes(node.class_type)) throw new Error(`Unsupported output node: ${node.class_type}`);
      outputs.push(nodeId);
      node.inputs.filename_prefix = `CodeBuddy/${id}`;
    }
    for (const [key, value] of Object.entries(node.inputs)) {
      if (value === '$prompt') {
        node.inputs[key] = input.transparent_background ? `${input.prompt}\nTransparent background with an alpha channel. No background or ground shadow.` : input.prompt;
        prompts++;
      }
      if (['$width', '$height', '$seed', '$duration_seconds'].includes(value)) {
        if (parameters[value] === undefined) throw new Error(`Supply ${value.slice(1)} to bind ${value}`);
        node.inputs[key] = parameters[value]; boundParameters.add(value);
      }
      if (Array.isArray(value)) {
        const [target, index] = value;
        if (value.length !== 2 || typeof target !== 'string' || !graph[target] || !Number.isSafeInteger(index) || index < 0 || index >= (info[graph[target].class_type]?.output?.length ?? 0))
          throw new Error(`Invalid connection at ${nodeId}.${key}`);
      }
    }
    if (node.class_type === 'LoadImage') {
      const match = /^\$reference:([01])$/.exec(node.inputs.image);
      if (!match || !references[Number(match[1])]) throw new Error('LoadImage must bind an uploaded $reference:0 or $reference:1');
      usedReferences.add(Number(match[1])); node.inputs.image = references[Number(match[1])];
    }
  }
  if (outputs.length !== 1 || !prompts || usedReferences.size !== references.length)
    throw new Error('Fallback requires one media output, $prompt and every supplied reference');
  if (Object.keys(parameters).some(key => !boundParameters.has(key))) throw new Error('Every supplied size, seed and duration parameter must be bound in fallback_workflow');
  const visited = new Set(), visiting = new Set();
  function visit(nodeId) {
    if (visiting.has(nodeId)) throw new Error('Workflow contains a cycle');
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const value of Object.values(graph[nodeId].inputs)) if (Array.isArray(value)) visit(value[0]);
    visiting.delete(nodeId); visited.add(nodeId);
  }
  visit(outputs[0]);
  if (visited.size !== Object.keys(graph).length) throw new Error('Every fallback node must connect to the media output');
  const missing = missingDependencies(graph, info);
  if (missing.length) throw new Error(`Fallback dependencies unavailable: ${JSON.stringify(missing)}`);
  const sha256 = createHash('sha256').update(JSON.stringify(source)).digest('hex');
  return { graph, metadata: { id: `fallback-${sha256.slice(0, 16)}`, label: '自适应工作流', source: 'agent-fallback', sha256, save_node: outputs[0], stages: {} } };
}
