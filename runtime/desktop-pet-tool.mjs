import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PET_TOOL_NAME = 'create_desktop_pet';
const states = ['idle', 'wave', 'jump', 'working', 'waiting', 'failed', 'review', 'look'];
const runtime = path.dirname(fileURLToPath(import.meta.url));
const instructions = 'Ask what character, colors, style and name the user wants if unspecified. Use a real image-capable model or available image-generation tool to generate consistent transparent poses. A text-only model can orchestrate these tools but does not itself output image pixels. Never substitute duplicated static frames or claim generation without image output. Generate either one 6-column × 8-row sheet or eight 3-column × 2-row grids in the session workspace. State order: idle breathing/blinking, wave, jump/land, focused work, waiting for input, failure reaction, completed/check, look up/upper-right/lower-right/down/lower-left/upper-left. Keep every full body inside each cell with transparent margins and at least three distinct poses per state. Then call assemble with sources. The tool registers the package for preview; only the user selects it as their desktop pet. If no image tool is available, explain the missing image service; do not invent capabilities.';

async function workspaceFile(cwd, input) {
  if (typeof input !== 'string' || !input) throw new Error('Image source path is required');
  const root = await realpath(cwd), file = await realpath(path.resolve(cwd, input));
  const relative = path.relative(root, file);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('Image sources must be inside this session workspace');
  const info = await stat(file);
  if (!info.isFile() || info.size > 20 * 1024 * 1024) throw new Error('Image source must be an ordinary file under 20 MiB');
  return file;
}
function runAssembler(args, signal) {
  signal?.throwIfAborted();
  const python = path.join(runtime, 'py/dependencies/python', ...(process.platform === 'win32' ? ['python.exe'] : ['bin/python3']));
  return new Promise((resolve, reject) => {
    const child = spawn(python, [path.join(runtime, 'assets/assemble-pet.py'), ...args], { windowsHide: true, signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let error = '', processError;
    child.stdout.resume();
    child.stderr.on('data', chunk => { error = (error + chunk.toString()).slice(-4000); });
    child.once('error', value => { processError = value; });
    child.once('close', code => processError ? reject(processError) : code === 0 ? resolve() : reject(new Error(`Pet assembly failed (${code}): ${error}`)));
  });
}
export function desktopPetTool({ cwd, directory = process.env.CODEBUDDY_PET_DIRECTORY, assemble = runAssembler }) {
  return {
    name: PET_TOOL_NAME,
    description: 'Create a custom animated desktop pet / 自定义桌面宠物. Prepare image requirements, then assemble generated pose images into a validated preview package. Uses the main Agent and its available image tools; never changes the selected pet.',
    inputSchema: { type: 'object', properties: {
      operation: { type: 'string', enum: ['prepare', 'assemble'] },
      id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,47}$' },
      name: { type: 'string', minLength: 1, maxLength: 80 },
      description: { type: 'string', maxLength: 500 },
      sources: { type: 'object', description: 'Paths are strings, for example {"idle":"generated-images/job/1.png"}. Supply one sheet or all eight states. Default layout is 3 columns x 2 rows. All paths must be in the session workspace.', properties: {
        sheet: { type: 'string' },
        ...Object.fromEntries(states.map(state => [state, { type: 'string' }])),
        layouts: { type: 'object', additionalProperties: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 12 }, minItems: 2, maxItems: 2 } },
        frameOrder: { type: 'object', additionalProperties: { type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 6, maxItems: 6 } },
      }, additionalProperties: false },
    }, required: ['operation'], additionalProperties: false },
    async execute(input, { signal } = {}) {
      if (!directory || !path.isAbsolute(directory)) throw new Error('Desktop pet library is not connected. Start creation from the desktop app.');
      if (input.operation === 'prepare') return { status: 'needs_images', instructions: `${instructions} In CodeBuddy, load generate_image with search_mcp_tools to use the configured ComfyUI service. For a named existing character, obtain and visually inspect original reference images first; web search text alone is not a visual reference. If no reliable image is available, ask the user for one rather than inventing appearance. Prefer approved generate_image workflows and pass the original reference_images to qwen_edit. If required template dependencies are missing, call generate_image inspect and follow its creation_allowed result to compose a fallback using installed nodes/models; never bypass the tool with scripts or download dependencies. For an original character, generate a first draft from the user brief. Show the draft and ask the user to confirm likeness BEFORE producing the eight animation states; do not treat a successful image job as user approval. After confirmation, reuse that approved image as reference_images for every 3-column by 2-row pose grid. Preserve face, hair, clothing and colors; vary only pose/expression unless requested. Submit each job once; poll status by job_id until completed, and pass the returned local paths to assemble.`, workspace: cwd, states, automaticallySelected: false };
      if (input.operation !== 'assemble') throw new Error('Unknown pet operation');
      if (!/^[a-z][a-z0-9-]{0,47}$/.test(input.id ?? '') || ['buddy','red-panda','cream-cat','white-fox'].includes(input.id)) throw new Error('Use a new non-reserved pet ID');
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 || typeof input.description !== 'string' || input.description.length > 500) throw new Error('Pet name and description are required');
      const sources = input.sources;
      if (!sources || typeof sources !== 'object') throw new Error('Generated image sources are required');
      const normalized = { id: input.id, name: input.name.trim(), description: input.description };
      for (const key of sources.sheet ? ['sheet'] : states) normalized[key] = await workspaceFile(cwd, sources[key]);
      for (const key of ['layouts', 'frameOrder']) if (sources[key]) normalized[key] = sources[key];
      await mkdir(directory, { recursive: true });
      const destination = path.join(directory, input.id);
      if (await stat(destination).catch(() => null)) throw new Error('Pet ID already exists; use a new ID to preserve the existing pet');
      const staging = await mkdtemp(path.join(directory, '.creating-'));
      try {
        await writeFile(path.join(staging, 'sources.json'), JSON.stringify(normalized));
        await assemble([path.join(staging, 'sources.json'), path.join(staging, 'package'), path.join(staging, 'preview')], signal);
        signal?.throwIfAborted();
        const report = JSON.parse(await readFile(path.join(staging, 'preview/validation.json'), 'utf8'));
        if (report.valid !== true) throw new Error('Pet validation did not pass');
        // One directory rename publishes complete assets. Existing pets are never overwritten.
        await rename(path.join(staging, 'package'), destination);
        return { status: 'ready_for_preview', id: input.id, directory: destination, frames: 48, states, automaticallySelected: false, visualReviewRequired: true,
          next: 'Open Settings → Virtual pet, refresh if needed, preview all animations, then click Set as desktop pet. Pixel checks do not prove character consistency or semantic gaze directions.' };
      } finally {
        // Only this invocation's fresh, known staging directory is removed.
        await rm(staging, { recursive: true, force: true });
      }
    },
  };
}
