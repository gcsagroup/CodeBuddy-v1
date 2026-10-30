import { createHash } from 'node:crypto';
import { missingDependencies, validateNodeInventory } from './comfyui-fallback.mjs';

const record = x => x && typeof x === 'object' && !Array.isArray(x);
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const notes = new Set(['Note', 'MarkdownNote']);
const primitives = new Set(['PrimitiveString', 'PrimitiveStringMultiline', 'PrimitiveInt', 'PrimitiveFloat', 'PrimitiveBoolean']);
const stages = { UNETLoader: 'model', CLIPLoader: 'clip', KSampler: 'sample', SamplerCustomAdvanced: 'sample', VAEDecode: 'decode', VAEDecodeTiled: 'decode', SaveImage: 'save', SaveImageAdvanced: 'save', SaveVideo: 'save', CreateVideo: 'video' };
export const workflowParameterProperties = {
  workflow_parameters: { type: 'array', maxItems: 32, description: 'Optional tuning for saved workflows only. Use exact parameter IDs and allowed values from inspect.tunable_parameters. Omitted controls retain saved defaults; never guess node IDs or replace graph links/models.',
    items: { type: 'object', properties: { parameter: { type: 'string' }, value: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] } }, required: ['parameter', 'value'], additionalProperties: false } },
};

// Convert saved data, never evaluate extension code. Unsupported virtual widgets
// remain an explicit compatibility error rather than permission to invent a graph.
export function compileSavedWorkflow(source, info) {
  const ui = structuredClone(source), graph = {}, origins = new Map();
  if (!Array.isArray(ui.nodes)) {
    if (!record(ui) || !Object.keys(ui).length || Object.values(ui).some(n => !record(n.inputs) || typeof n.class_type !== 'string')) throw new Error('Invalid saved workflow');
    return { graph: ui, ui: null, origins, set(id, key, value) { ui[id].inputs[key] = value; } };
  }
  const definitions = new Map((ui.definitions?.subgraphs ?? []).map(s => [s.id, s]));
  const contexts = [], resolving = new Set();
  function context(data, prefix = '', parent = null, host = null, ancestors = []) {
    if (!Array.isArray(data.nodes) || data.nodes.length > 512 || !Array.isArray(data.links)) throw new Error('Invalid or oversized saved graph');
    if (ancestors.includes(data.id)) throw new Error('Recursive subgraph');
    const ctx = { data, prefix, parent, host, nodes: new Map(data.nodes.map(n => [String(n.id), n])), children: new Map() };
    contexts.push(ctx);
    if (contexts.length > 128) throw new Error('Too many subgraphs');
    for (const n of data.nodes) if (definitions.has(n.type)) ctx.children.set(String(n.id), context(structuredClone(definitions.get(n.type)), `${prefix}${n.id}:`, ctx, n, [...ancestors, data.id]));
    return ctx;
  }
  function widget(node, key, definition) {
    const named = node.widgets_values_named;
    let index;
    if (record(named) && Object.hasOwn(named, key)) index = Object.keys(named).indexOf(key);
    else {
      const fields = { ...definition?.input?.required, ...definition?.input?.optional };
      let offset = 0;
      for (const [name, schema] of Object.entries(fields)) {
        if (!['STRING', 'INT', 'FLOAT', 'BOOLEAN', 'COMBO'].includes(schema[0]) && !Array.isArray(schema[0])) continue;
        if (schema[1]?.forceInput) continue;
        if (name === key) { index = offset; break; }
        offset += schema[1]?.control_after_generate ? 2 : 1;
      }
    }
    const value = record(named) && Object.hasOwn(named, key) ? named[key] : node.widgets_values?.[index];
    if (value === undefined || value === null) throw new Error(`Unresolved widget ${node.id}.${key}; save named widget values or an API-format workflow`);
    return { value: Array.isArray(value) ? { __value__: value } : value, origin: { node, key, index } };
  }
  function link(ctx, id) {
    const raw = ctx.data.links.find(l => (Array.isArray(l) ? l[0] : l.id) === id);
    if (!raw) throw new Error(`Missing link ${id}`);
    return Array.isArray(raw) ? { origin_id: raw[1], origin_slot: raw[2], target_id: raw[3], target_slot: raw[4] } : raw;
  }
  function input(ctx, node, slot) {
    const i = node.inputs?.[slot];
    if (!i) throw new Error(`Missing input ${node.id}:${slot}`);
    if (i.link != null) { const l = link(ctx, i.link); return output(ctx, l.origin_id, l.origin_slot); }
    if (!i.widget) return undefined;
    return widget(node, i.name, info[node.type]);
  }
  function output(ctx, id, slot) {
    const token = `${ctx.prefix}${id}/${slot}`;
    if (resolving.has(token)) throw new Error('Cyclic virtual connection');
    resolving.add(token);
    try {
      if (ctx.parent && id === ctx.data.inputNode?.id) return input(ctx.parent, ctx.host, slot);
      const node = ctx.nodes.get(String(id));
      if (!node) throw new Error(`Missing node ${id}`);
      if (node.mode === 2 || node.mode === 4) throw new Error(`Muted/bypassed node ${id} needs frontend export`);
      const sub = ctx.children.get(String(id));
      if (sub) {
        const l = sub.data.links.find(l => l.target_id === sub.data.outputNode.id && l.target_slot === slot);
        if (!l) throw new Error(`Unresolved subgraph output ${id}`);
        return output(sub, l.origin_id, l.origin_slot);
      }
      if (node.type === 'Reroute') return input(ctx, node, 0);
      if (node.type === 'PrimitiveNode') {
        if (!node.widgets_values?.length) throw new Error('Empty primitive');
        return { value: node.widgets_values[0], origin: { node, key: 'value', index: 0 } };
      }
      return { value: [`${ctx.prefix}${id}`, slot] };
    } finally { resolving.delete(token); }
  }
  context(ui);
  for (const ctx of contexts) for (const node of ctx.nodes.values()) {
    if (notes.has(node.type) || ctx.children.has(String(node.id)) || ['Reroute', 'PrimitiveNode'].includes(node.type)) continue;
    if (node.mode === 2 || node.mode === 4) throw new Error(`Muted/bypassed node ${node.id} needs frontend export`);
    const id = `${ctx.prefix}${node.id}`, inputs = {};
    const definition = info[node.type];
    const fields = { ...definition?.input?.required, ...definition?.input?.optional };
    const declaredWidgets = (node.inputs ?? []).filter(i => i.widget).map(i => i.name);
    const names = record(node.widgets_values_named)
      ? Object.keys(node.widgets_values_named).filter(k => Object.hasOwn(fields, k) || declaredWidgets.includes(k))
      : Object.keys(fields).filter(k => ['STRING', 'INT', 'FLOAT', 'BOOLEAN', 'COMBO'].includes(fields[k][0]) || Array.isArray(fields[k][0]));
    if (!definition && node.widgets_values?.length && !record(node.widgets_values_named)) throw new Error(`Missing schema for ${node.type}`);
    for (const key of names) {
      const w = widget(node, key, definition); inputs[key] = w.value; origins.set(`${id}/${key}`, w.origin);
    }
    for (const [slot, i] of (node.inputs ?? []).entries()) if (i.link != null) {
      const resolved = input(ctx, node, slot);
      if (!resolved) { delete inputs[i.name]; continue; }
      inputs[i.name] = resolved.value;
      if (resolved.origin) origins.set(`${id}/${i.name}`, resolved.origin);
    }
    graph[id] = { class_type: node.type, inputs, _meta: { title: node.title ?? node.type } };
    if (Object.keys(graph).length > 1024) throw new Error('Saved workflow exceeds 1024 executable nodes');
  }
  // Each subgraph instance needs its own serialized definition when parameter
  // edits target internal widgets; refuse shared definitions instead of lying in metadata.
  for (const ctx of contexts.slice(1)) {
    if (contexts.filter(c => c.data.id === ctx.data.id).length > 1) throw new Error('Repeated subgraph instances require an API-format export');
    ui.definitions.subgraphs[ui.definitions.subgraphs.findIndex(s => s.id === ctx.data.id)] = ctx.data;
  }
  return { graph, ui, origins, set(id, key, value) {
    const origin = origins.get(`${id}/${key}`);
    if (!origin) throw new Error(`No writable saved widget for ${id}.${key}`);
    graph[id].inputs[key] = value;
    origin.node.widgets_values_named ??= {};
    origin.node.widgets_values_named[origin.key] = value;
    if (origin.index !== undefined && Array.isArray(origin.node.widgets_values)) origin.node.widgets_values[origin.index] = value;
  } };
}

function ancestors(graph, output) {
  const visited = new Set(), active = new Set();
  function visit(id) {
    if (active.has(id)) throw new Error('Workflow contains a cycle');
    if (visited.has(id)) return;
    const n = graph[id]; if (!n) throw new Error(`Missing connected node ${id}`);
    active.add(id);
    for (const v of Object.values(n.inputs)) if (Array.isArray(v)) visit(v[0]);
    active.delete(id); visited.add(id);
  }
  visit(output); return visited;
}
function scalarSlot(graph, id, key) {
  const value = graph[id]?.inputs[key];
  if (Array.isArray(value)) {
    const source = graph[value[0]];
    if (!primitives.has(source?.class_type) || value[1] !== 0) throw new Error(`Parameter ${id}.${key} is computed, not directly writable`);
    return [value[0], 'value'];
  }
  if (value === undefined) throw new Error(`Missing parameter ${id}.${key}`);
  return [id, key];
}
function durationSlot(graph) {
  const encoders = Object.values(graph).filter(n => ['MiniMaxH3ImageToVideo', 'MiniMaxH3ReferenceToVideo'].includes(n.class_type));
  if (encoders.length !== 1) return null;
  const length = encoders[0].inputs.length, expression = Array.isArray(length) ? graph[length[0]] : null;
  const durations = expression?.class_type === 'ComfyMathExpression'
    ? Object.values(expression.inputs).filter(Array.isArray).filter(v => graph[v[0]]?.class_type === 'PrimitiveFloat') : [];
  return durations.length === 1 ? [durations[0][0], 'value'] : null;
}

// Only generation controls are writable. Files, models, prompts, expressions and
// graph edges keep their existing dedicated binding/authorization paths.
const tuningFields = {
  KSampler: ['steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'],
  BasicScheduler: ['steps', 'scheduler', 'denoise'], KSamplerSelect: ['sampler_name'],
  CFGGuider: ['cfg'], LoraLoaderModelOnly: ['strength_model'], LoraLoader: ['strength_model', 'strength_clip'],
  MiniMaxH3ReferenceToVideo: ['ref_image_size'],
};
function tuningControls(compiled, graph, info) {
  const controls = new Map();
  function add(id, key, schema, binding) {
    if (!schema) return;
    const [rawType, settings = {}] = schema;
    const options = Array.isArray(rawType) ? rawType : rawType === 'COMBO' ? settings.options : undefined;
    const type = options ? 'enum' : ({ INT: 'integer', FLOAT: 'number', BOOLEAN: 'boolean' })[rawType];
    if (!type || (options && options.some(v => !['string', 'number', 'boolean'].includes(typeof v)))) return;
    if (compiled.ui && !compiled.origins.has(`${id}/${key}`)) return;
    const value = graph[id]?.inputs[key];
    if (!['string', 'number', 'boolean'].includes(typeof value)) return;
    const parameter = `${id}/${key}`;
    const rule = { type, ...(options ? { options } : {}),
      ...(Number.isFinite(settings.min) ? { minimum: settings.min } : {}),
      ...(Number.isFinite(settings.max) ? { maximum: settings.max } : {}) };
    const control = controls.get(parameter) ?? { parameter, node: id, input: key, current: value, label: graph[id]._meta?.title ?? graph[id].class_type, constraints: [], bindings: [] };
    control.constraints.push(rule); control.bindings.push(binding); controls.set(parameter, control);
  }
  function resolve(id, key, schema, binding, seen = new Set()) {
    const token = `${id}/${key}`;
    if (seen.has(token)) return;
    seen = new Set([...seen, token]);
    const value = graph[id]?.inputs[key];
    if (!Array.isArray(value)) { add(id, key, schema, binding); return; }
    const source = graph[value[0]];
    if (value[1] !== 0) return;
    if (primitives.has(source?.class_type)) add(value[0], 'value', schema, binding);
    else if (source?.class_type === 'ComfySwitchNode') {
      resolve(value[0], 'switch', ['BOOLEAN'], { ...binding, role: 'branch_switch' }, seen);
      for (const branch of ['on_false', 'on_true']) resolve(value[0], branch, schema, { ...binding, branch }, seen);
    }
  }
  for (const [id, node] of Object.entries(graph)) {
    const fields = { ...info[node.class_type]?.input?.required, ...info[node.class_type]?.input?.optional };
    for (const key of tuningFields[node.class_type] ?? []) {
      if (Object.hasOwn(node.inputs, key)) resolve(id, key, fields[key], { node: id, type: node.class_type, input: key });
    }
  }
  return [...controls.values()];
}

function applyTuning(compiled, spec, input, info) {
  const overrides = input.workflow_parameters;
  if (overrides === undefined) return;
  if (!Array.isArray(overrides) || overrides.length > 32) throw new Error('workflow_parameters must contain at most 32 controls');
  const controls = tuningControls(compiled, spec.graph, info), seen = new Set();
  for (const override of overrides) {
    if (!record(override) || Object.keys(override).some(k => !['parameter', 'value'].includes(k))) throw new Error('Invalid workflow parameter override');
    const control = controls.find(c => c.parameter === override.parameter);
    if (!control || seen.has(control.parameter)) throw new Error(`Unknown or duplicate workflow parameter: ${override.parameter}; inspect again`);
    seen.add(control.parameter);
    const value = override.value;
    for (const rule of control.constraints) {
      const validType = rule.type === 'enum' ? rule.options.includes(value)
        : rule.type === 'boolean' ? typeof value === 'boolean'
          : typeof value === 'number' && Number.isFinite(value) && (rule.type !== 'integer' || Number.isSafeInteger(value));
      if (!validType || (rule.minimum !== undefined && value < rule.minimum) || (rule.maximum !== undefined && value > rule.maximum))
        throw new Error(`Invalid value for workflow parameter ${control.parameter}; inspect its live constraints`);
    }
    compiled.set(control.node, control.input, value);
  }
}
function describe(compiled, info) {
  const all = compiled.graph;
  const saves = Object.entries(all).filter(([,n]) => ['SaveImage', 'SaveImageAdvanced', 'SaveVideo'].includes(n.class_type));
  if (saves.length !== 1) throw new Error('Saved workflow needs exactly one supported media output');
  const [saveNode, save] = saves[0], used = ancestors(all, saveNode);
  const graph = Object.fromEntries(Object.entries(all).filter(([id]) => used.has(id)));
  const nodes = Object.entries(graph), references = nodes.filter(([,n]) => n.class_type === 'LoadImage').map(([id]) => id);
  const kind = save.class_type === 'SaveVideo' ? 'video' : 'image';
  const mode = kind === 'image' ? (references.length ? 'image_to_image' : 'text_to_image')
    : nodes.some(([,n]) => n.class_type === 'MiniMaxH3ReferenceToVideo') ? 'reference_to_video' : references.length ? 'image_to_video' : 'text_to_video';
  const prompts = nodes.filter(([,n]) => ['TextEncodeQwenImage21', 'MiniMaxH3ImageToVideo', 'MiniMaxH3ReferenceToVideo'].includes(n.class_type)).map(([id]) => scalarSlot(graph, id, 'prompt'));
  if (!prompts.length) {
    const positive = new Set();
    for (const [,n] of nodes) for (const key of ['positive', 'conditioning']) if (Array.isArray(n.inputs[key])) for (const id of ancestors(graph, n.inputs[key][0])) positive.add(id);
    for (const [id,n] of nodes) if (positive.has(id) && n.class_type === 'CLIPTextEncode') prompts.push(scalarSlot(graph,id,'text'));
  }
  if (!prompts.length) throw new Error('Prompt binding is not supported for this saved workflow');
  const missing = missingDependencies(graph, info);
  if (kind === 'image' && save.class_type === 'SaveImageAdvanced' && save.inputs.format !== 'png') missing.push({type:'output_format', value:save.inputs.format, required:'png'});
  if (kind === 'video' && (!['auto','mp4'].includes(save.inputs.format) || ['av1'].includes(save.inputs['format.codec']))) missing.push({type:'output_format', required:'mp4'});
  return { graph, kind, mode, references, prompts, saveNode, missing };
}

export async function savedWorkflowCatalog(read, info, kind, mode, referenceCount, nodeTypes = [], nodeOffset = 0) {
  validateNodeInventory(info);
  if (!Array.isArray(nodeTypes) || nodeTypes.length > 24 || nodeTypes.some(x => typeof x !== 'string') || !Number.isSafeInteger(nodeOffset) || nodeOffset < 0) throw new Error('Invalid node schema pagination');
  const wanted = kind === 'image' ? (referenceCount ? 'image_to_image' : 'text_to_image') : mode;
  if (!['text_to_image','image_to_image','text_to_video','image_to_video','reference_to_video'].includes(wanted)) throw new Error('Choose a generation mode');
  const paths = await read('/userdata?dir=workflows&recurse=true&split=false');
  if (!Array.isArray(paths) || paths.length > 200 || paths.some(p => typeof p !== 'string' || p.startsWith('/') || p.includes('\\') || p.split('/').some(s => s === '..' || s === '.'))) throw new Error('Saved workflow listing is invalid or too large');
  const entries = [], workflows = [], blockers = [];
  for (const file of paths.filter(p => p.endsWith('.json')).sort()) {
    // Transport failures abort the catalog. They never mean "no workflows".
    const source = await read(`/userdata/${encodeURIComponent(`workflows/${file}`)}`);
    const id = `saved:${file}`;
    try {
      const compiled = compileSavedWorkflow(source, info), spec = describe(compiled, info);
      const entry = { id, file, source, sha256: hash(source), compiled, ...spec };
      entries.push(entry);
      const compatible = spec.kind === kind && spec.mode === wanted && referenceCount <= spec.references.length;
      workflows.push({ id, label: file.replace(/\.json$/, ''), mode: spec.mode, source: `workflows/${file}`, compatible, dependencies_available: !spec.missing.length, missing: spec.missing, reference_slots: spec.references.length,
        tunable_parameters: tuningControls(compiled, spec.graph, info),
        ...(durationSlot(spec.graph) ? { duration_seconds: spec.graph[durationSlot(spec.graph)[0]].inputs.value } : {}),
        parameters: Object.entries(spec.graph).filter(([,n])=>['ResolutionSelector','KSampler','BasicScheduler','CreateVideo'].includes(n.class_type)).map(([node,n])=>({node,type:n.class_type,values:Object.fromEntries(Object.entries(n.inputs).filter(([,v])=>!Array.isArray(v)))})) });
    } catch (error) {
      blockers.push({ id, source: `workflows/${file}`, error: error.message });
    }
  }
  const names = Object.keys(info).sort();
  return { entries, public: { workflows, blockers, creation_allowed: !blockers.length && !workflows.some(w => w.compatible && w.dependencies_available),
    note: 'Live saved ComfyUI workflows. Select a compatible workflow_id. Unsupported saved formats, network errors, queueing and execution failures never authorize replacement. Saved changes are read again on generation; unsaved browser edits are not included.',
    node_count: names.length, node_types: names.slice(nodeOffset,nodeOffset+300), next_node_offset: nodeOffset+300<names.length?nodeOffset+300:null, schemas:Object.fromEntries(nodeTypes.map(n=>[n,info[n]??null])) } };
}

export function selectSavedWorkflow(catalog, input) {
  const available = catalog.public.workflows.filter(w=>w.compatible && w.dependencies_available);
  const selected = input.workflow_id ? available.find(w=>w.id===input.workflow_id) : available.length === 1 ? available[0] : null;
  if (!selected) throw new Error(`Select an available saved workflow_id from operation=inspect. ${available.length} compatible workflows; no automatic replacement was submitted.`);
  return catalog.entries.find(e=>e.id===selected.id);
}
export function prepareSavedWorkflow(entry, input, references, jobId, info) {
  const compiled = compileSavedWorkflow(entry.source, info), spec = describe(compiled, info), graph = spec.graph;
  applyTuning(compiled, spec, input, info);
  const set = (id,key,value)=>compiled.set(id,key,value);
  for (const [id,key] of spec.prompts) set(id,key,input.transparent_background ? `${input.prompt}\nTransparent background with an alpha channel. No background or ground shadow.` : input.prompt);
  for (const [id,n] of Object.entries(graph)) for (const key of ['seed','noise_seed']) if (Object.hasOwn(n.inputs,key)) {
    const slot=scalarSlot(graph,id,key); set(...slot,input.seed ?? Math.floor(Math.random()*2**48));
  }
  spec.references.forEach((id,i)=>set(id,'image',references[i]??references[0]));
  set(spec.saveNode,'filename_prefix',`CodeBuddy/${jobId}`);
  if (input.width !== undefined || input.height !== undefined) {
    const sizeNodes = Object.entries(graph).filter(([,n])=>n.class_type==='ResolutionSelector');
    if(sizeNodes.length!==1) throw new Error('Saved workflow has no unique resolution selector; preserve its saved size');
    const width=input.width??1024,height=input.height??1024;
    const ratios=[[1,1,'Square'],[2,3,'Portrait Photo'],[3,2,'Photo'],[3,4,'Portrait Standard'],[4,3,'Standard'],[9,16,'Portrait Widescreen'],[16,9,'Widescreen'],[21,9,'Ultrawide']];
    const ratio=ratios.find(([w,h])=>width*h===height*w); if(!ratio)throw new Error('Unsupported aspect ratio');
    const id=sizeNodes[0][0]; set(id,'aspect_ratio',`${ratio[0]}:${ratio[1]} (${ratio[2]})`);set(id,'megapixels',width*height/1024**2);set(id,'multiple',32);
    for (const [switchId,n] of Object.entries(graph)) if (n.class_type === 'ComfySwitchNode') {
      const target = graph[n.inputs.on_true?.[0]];
      if (target?.class_type === 'EmptyLatentImage' && target.inputs.width?.[0] === id && target.inputs.height?.[0] === id)
        set(...scalarSlot(graph,switchId,'switch'),true);
    }
  }
  if(input.duration_seconds!==undefined){
    const slot = durationSlot(graph);
    if (!slot) throw new Error('Duration is not exposed as a unique seconds parameter');
    set(...slot,input.duration_seconds);
  }
  return { graph, ui:compiled.ui, metadata:{id:entry.id,label:entry.file.replace(/\.json$/,''),source:`workflows/${entry.file}`,sha256:entry.sha256,save_node:spec.saveNode,stages:Object.fromEntries(Object.entries(graph).map(([id,n])=>[id,stages[n.class_type]??'prepare']))} };
}
