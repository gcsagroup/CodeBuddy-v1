import { watchMedia, mediaStreamKey, mediaObservation, stopMedia } from './comfyui-live.mjs';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat, statfs, open, unlink, writeFile, rename, readdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const IMAGE_TOOL_NAME = 'generate_image';
export const DEFAULT_COMFYUI_URL = 'http://192.168.9.111:8188';
const refreshes = new Map();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const models = {
  unet: 'qwen_image_2.1_int8_convrot.safetensors',
  clip: 'qwen3vl_8b_int8_convrot.safetensors',
  vae: 'qwen_image_2.1_vae_bf16.safetensors',
};
export function comfyuiUrl(value = DEFAULT_COMFYUI_URL) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('ComfyUI URL must be HTTP(S), without credentials, query or fragment');
  return url.href.replace(/\/$/, '');
}
function integer(value, fallback, min, max, multiple = 1) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max || result % multiple)
    throw new Error(`Expected an integer ${min}..${max}, multiple of ${multiple}`);
  return result;
}
async function inside(cwd, file) {
  const root = await realpath(cwd), resolved = await realpath(file);
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error('Image files must stay inside the current workspace');
  return resolved;
}
async function limitedBody(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) throw new Error('ComfyUI response is too large');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('ComfyUI response is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function pngDimensions(bytes) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.toString('ascii', 12, 16) !== 'IHDR')
    throw new Error('ComfyUI did not return a PNG image');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width * height > 16_777_216) throw new Error('Generated image dimensions exceed the supported limit');
  return { width, height };
}
export function comfyWorkflow(input, references, id) {
  const width = integer(input.width, 1024, 256, 2048, 32);
  const height = integer(input.height, 1024, 256, 2048, 32);
  const prompt = input.transparent_background
    ? `This is an RGBA image with transparency. ${input.prompt}\nTransparent background with an alpha channel. No background or ground shadow.`
    : input.prompt;
  const node = (class_type, inputs) => ({ class_type, inputs });
  const graph = {
    model: node('UNETLoader', { unet_name: models.unet, weight_dtype: 'default' }),
    clip: node('CLIPLoader', { clip_name: models.clip, type: 'qwen_image', device: 'default' }),
    vae: node('VAELoader', { vae_name: models.vae }),
    encode: node('TextEncodeQwenImage21', { clip: ['clip', 0], vae: ['vae', 0], prompt, negative_prompt: '', resolution: 1024 }),
    latent: node('EmptyLatentImage', { width, height, batch_size: 1 }),
    sample: node('KSampler', { seed: integer(input.seed, Math.floor(Math.random() * 2 ** 48), 0, Number.MAX_SAFE_INTEGER), steps: 25, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['model', 0], positive: ['encode', 0], negative: ['encode', 1], latent_image: ['latent', 0] }),
    decode: node('VAEDecode', { samples: ['sample', 0], vae: ['vae', 0] }),
    save: node('SaveImageAdvanced', { images: ['decode', 0], filename_prefix: `CodeBuddy/${id}`, format: 'png', 'format.bit_depth': '8-bit', 'format.input_color_space': 'sRGB' }),
  };
  references.forEach((image, i) => {
    graph[`reference${i}`] = node('LoadImage', { image });
    graph.encode.inputs[`images.image_${i + 1}`] = [`reference${i}`, 0];
  });
  return graph;
}

export function comfyuiTool(options) {
  return comfyuiMediaTool(options);
}

// Both media tools share the same receipts, cancellation and output-publication rules.
export function comfyuiMediaTool({ cwd, dataDir, sessionId, baseUrl = DEFAULT_COMFYUI_URL, fetchImpl = fetch, statfsImpl = statfs }, media) {
  const toolName = media?.name ?? IMAGE_TOOL_NAME;
  const kind = media ? 'video' : 'image';
  const outputKey = media ? 'videos' : 'images';
  const workflow = media?.workflow ?? comfyWorkflow;
  const server = comfyuiUrl(baseUrl);
  // Receipts belong to this session, independent of a model-supplied filesystem path.
  const records = path.join(dataDir, `${kind}-jobs`, Buffer.from(sessionId).toString('hex'));
  async function checkSpace(directory, bytes = 0) {
    const disk = await statfsImpl(directory);
    const available = Number(disk.bavail) * Number(disk.bsize);
    // Leave room for receipts and other applications; this is a preflight, not a reservation.
    if (available < bytes + 512 * 1024 * 1024) {
      throw new Error(`磁盘空间不足：${directory} 剩余 ${Math.floor(available / 1024 / 1024)} MiB。请释放空间或选择其他磁盘后重试；已有作品会保留。Low disk space; keep at least 512 MiB free plus the output size.`);
    }
  }
  async function request(base, route, { signal, ...options } = {}) {
    const timeout = AbortSignal.timeout(300_000);
    const response = await fetchImpl(`${comfyuiUrl(base)}${route}`, {
      ...options, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      const error = new Error(`ComfyUI ${route.split('?')[0]} returned HTTP ${response.status}: ${(await limitedBody(response, 4000)).toString().slice(0, 1000)}`);
      error.status = response.status; throw error;
    }
    return response;
  }
  const json = async (base, route, options) => JSON.parse((await limitedBody(await request(base, route, options), 4 * 1024 * 1024)).toString());
  const post = (body, signal) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  async function save(job) {
    await mkdir(records, { recursive: true });
    const file = path.join(records, `${job.job_id}.json`), temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(job)); await rename(temp, file);
  }
  async function load(id) {
    if (!uuid.test(id ?? '')) throw new Error('A valid job_id from generate is required');
    return JSON.parse(await readFile(path.join(records, `${id}.json`), 'utf8'));
  }
  const streamKey = job => mediaStreamKey(dataDir, sessionId, kind, job.job_id);
  function result(job) {
    return { job_id: job.job_id, prompt_id: job.prompt_id, status: job.status, [outputKey]: job[outputKey] ?? [], error: job.error ?? null,
      kind, created_at: job.created_at,
      next: ['completed', 'failed', 'cancelled'].includes(job.status) ? null
        : ['submission_unknown', 'unavailable'].includes(job.status) ? 'Submission or server history is uncertain. Check this job_id with status; do not generate again automatically.'
          : `Call ${toolName} with operation=status, this job_id and wait_seconds=30. Do not submit generation again.` };
  }
  async function refreshJob(job, signal) {
    if (!['completed', 'failed', 'cancelled'].includes(job.status) && fetchImpl === fetch)
      await watchMedia(streamKey(job), job.server, job);
    // Older video receipts used image Markdown. Refresh their output metadata once
    // without resubmitting generation, so chat can offer a playable HTTP link.
    const needsVideoLink = media && job.status === 'completed' && job.videos?.some(video => !video.preview_url);
    if (['completed', 'failed', 'cancelled'].includes(job.status) && !needsVideoLink) return result(job);
    const history = await json(job.server, `/history/${encodeURIComponent(job.prompt_id)}`, { signal }).catch(error => {
      // A missing optional playback link must not invalidate an already saved output.
      if (needsVideoLink) return {};
      throw error;
    });
    const item = history[job.prompt_id];
    if (needsVideoLink && item?.status?.completed !== true) return result(job);
    if (item?.status?.status_str === 'error') {
      job.status = job.cancel_requested && item.status.messages?.some(x => x[0] === 'execution_interrupted') ? 'cancelled' : 'failed';
      job.error = JSON.stringify(item.status.messages ?? []).slice(0, 2500);
    } else if (item?.status?.completed === true) {
      const outputs = (media ? media.outputs(item.outputs?.save) : item.outputs?.save?.images ?? []).filter(x => x.type === 'output');
      if (!outputs.length) { job.status = 'failed'; job.error = `ComfyUI completed without a saved ${kind}`; }
      else {
        const root = await realpath(cwd);
        const output = path.join(root, `generated-${outputKey}`);
        await mkdir(output, { recursive: true }); await inside(root, output);
        const directory = path.join(output, job.job_id);
        await mkdir(directory, { recursive: true }); await inside(root, directory);
        job[outputKey] = [];
        for (const [i, image] of outputs.slice(0, 8).entries()) {
          await checkSpace(directory);
          const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: 'output' });
          const bytes = await limitedBody(await request(job.server, `/view?${query}`, { signal }), media?.maxBytes ?? 32 * 1024 * 1024);
          const dimensions = media ? media.inspect(bytes) : pngDimensions(bytes);
          const file = path.join(directory, `${i + 1}.${media?.extension ?? 'png'}`);
          // Exclusive writes preserve user changes, including links placed at an output path.
          try {
            await checkSpace(directory, bytes.length);
            const handle = await open(file, 'wx');
            try { await handle.writeFile(bytes); }
            catch (error) {
              await handle.close();
              await unlink(file);
              throw error;
            }
            await handle.close();
          }
          catch (error) {
            if (error.code !== 'EEXIST' || !bytes.equals(await readFile(await inside(root, file)))) throw error;
          }
          const previewUrl = `${comfyuiUrl(job.server)}/view?${query}`;
          job[outputKey].push({ path: file, ...dimensions,
            ...(media
              ? { preview_url: previewUrl, markdown: `[Play generated video](${previewUrl})` }
              : { markdown: `![Generated image](${file.replaceAll('\\', '/')})` }),
          });
        }
        job.status = 'completed';
      }
    } else {
      const queue = await json(job.server, '/queue', { signal });
      job.status = queue.queue_running?.some(x => x[1] === job.prompt_id) ? 'running'
        : queue.queue_pending?.some(x => x[1] === job.prompt_id) ? 'queued'
          : job.cancel_requested ? 'cancelled' : job.status === 'submission_unknown' ? 'submission_unknown' : 'unavailable';
    }
    await save(job);
    const value = result(job);
    if (['completed', 'failed', 'cancelled'].includes(job.status)) stopMedia(streamKey(job));
    return value;
  }
  async function refresh(job, signal) {
    const key = streamKey(job);
    if (refreshes.has(key)) return refreshes.get(key);
    const pending = refreshJob(job, signal).finally(() => refreshes.delete(key));
    refreshes.set(key, pending); return pending;
  }
  return {
    async jobs() {
      const files = await readdir(records).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      const jobs = await Promise.all(files.filter(file => uuid.test(file.replace(/\.json$/, '')) && file.endsWith('.json')).map(async file => JSON.parse(await readFile(path.join(records, file), 'utf8'))));
      const latest = jobs.sort((a,b) => b.created_at.localeCompare(a.created_at)).slice(0, 20);
      return Promise.all(latest.map(async job => {
        try {
          const value = ['preparing', 'submission_unknown'].includes(job.status) ? result(job) : await refresh(job, AbortSignal.timeout(15_000));
          return { ...value, live: mediaObservation(streamKey(job)) };
        } catch { return { ...result(job), live: mediaObservation(streamKey(job)), observation_error: true }; }
      }));
    },
    name: toolName,
    description: media?.description ?? 'Generate or edit any image with the configured ComfyUI service / 生图、图片编辑、透明素材、宠物动画. Submit once; use status with job_id to wait and download actual PNGs. Supports up to two workspace-local reference images. Main Agent writes the prompt. Never report completion before status=completed. Do not use shell scripts for this workflow.',
    inputSchema: media?.inputSchema ?? { type: 'object', properties: {
      operation: { type: 'string', enum: ['generate', 'status', 'cancel'] },
      prompt: { type: 'string', minLength: 1, maxLength: 12000 },
      reference_images: { type: 'array', maxItems: 2, items: { type: 'string' } },
      transparent_background: { type: 'boolean' },
      width: { type: 'integer', minimum: 256, maximum: 2048, multipleOf: 32 },
      height: { type: 'integer', minimum: 256, maximum: 2048, multipleOf: 32 },
      seed: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      request_id: { type: 'string', pattern: uuid.source, description: 'Optional UUID idempotency key (8-4-4-4-12 hexadecimal digits). Omit to generate one automatically. Reuse only for the exact same request.' },
      job_id: { type: 'string' }, wait_seconds: { type: 'integer', minimum: 0, maximum: 30 },
    }, required: ['operation'], additionalProperties: false },
    async execute(input, { signal } = {}) {
      signal?.throwIfAborted();
      if (input.operation === 'generate') {
        if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 12000) throw new Error(`Describe the ${kind} to generate`);
        const refs = media ? media.references(input) : input.reference_images ?? [];
        if (!Array.isArray(refs) || refs.length > 2) throw new Error('At most two reference images are supported');
        const id = input.request_id ?? randomUUID();
        if (!uuid.test(id)) throw new Error('request_id must be a UUID');
        // Validate dimensions before contacting the service.
        workflow(input, [], id);
        // An existing receipt remains queryable even when the disk becomes full.
        const existing = await load(id).catch(error => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (existing) {
          if (JSON.stringify(existing.input) !== JSON.stringify(input)) throw new Error(`request_id already belongs to a different ${kind} request`);
          return result(existing);
        }
        await checkSpace(cwd, media?.maxBytes ?? 32 * 1024 * 1024);
        await checkSpace(dataDir);
        await mkdir(records, { recursive: true });
        const job = { job_id: id, prompt_id: id, server, status: 'preparing', created_at: new Date().toISOString(), input };
        try { await writeFile(path.join(records, `${id}.json`), JSON.stringify(job), { flag: 'wx' }); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const old = await load(id);
          if (JSON.stringify(old.input) !== JSON.stringify(input)) throw new Error(`request_id already belongs to a different ${kind} request`);
          return result(old);
        }
        try {
          const uploaded = [];
          for (const [i, file] of refs.entries()) {
            if (typeof file !== 'string') throw new Error('Reference image path is required');
            const local = await inside(cwd, path.resolve(cwd, file));
            const info = await stat(local);
            if (!info.isFile() || info.size > 20 * 1024 * 1024) throw new Error('Reference image must be an ordinary file under 20 MiB');
            const bytes = await readFile(local); pngDimensions(bytes);
            const form = new FormData(); form.append('image', new Blob([bytes], { type: 'image/png' }), `${id}-${i}.png`); form.append('overwrite', 'false');
            const upload = await json(server, '/upload/image', { method: 'POST', body: form, signal });
            uploaded.push(`${upload.subfolder ? upload.subfolder + '/' : ''}${upload.name}`);
          }
          job.status = 'submission_unknown'; await save(job);
          if (fetchImpl === fetch) await watchMedia(streamKey(job), server, job);
          const receipt = await json(server, '/prompt', post({ prompt_id: id, client_id: id, extra_data: { preview_method: 'auto' }, prompt: workflow(input, uploaded, id) }, signal));
          if (!uuid.test(receipt.prompt_id ?? '')) throw new Error('ComfyUI did not return a valid prompt_id');
          job.prompt_id = receipt.prompt_id; job.status = 'queued'; await save(job);
          return result(job);
        } catch (error) {
          if (job.status !== 'submission_unknown' || (error.status && error.status < 500)) job.status = 'failed';
          job.error = error.message; await save(job); return result(job);
        }
      }
      const job = await load(input.job_id);
      if (input.operation === 'cancel') {
        await refresh(job, signal);
        if (['completed', 'failed', 'cancelled'].includes(job.status)) return result(job);
        try {
          const receipt = await json(job.server, `/api/jobs/${job.prompt_id}/cancel`, post({}, signal));
          if (receipt.cancelled) { job.cancel_requested = true; await save(job); await refresh(job, signal); }
          return { ...result(job), cancellation_confirmed: job.status === 'cancelled' };
        } catch (error) {
          // Older servers only expose a global interrupt; never stop another client's work.
          if (error.status !== 404 && error.status !== 405) throw error;
          return { ...result(job), cancellation_confirmed: false, error: 'This ComfyUI server has no per-job cancellation endpoint. Stop this job in ComfyUI; global interruption was not sent.' };
        }
      }
      if (input.operation !== 'status') throw new Error(`Unknown ${kind} operation`);
      const deadline = Date.now() + integer(input.wait_seconds, 0, 0, 30) * 1000;
      do {
        const current = await refresh(job, signal);
        if (!['queued', 'running'].includes(current.status) || Date.now() >= deadline) return current;
        await delay(Math.min(1500, deadline - Date.now()), undefined, { signal });
      } while (true);
    },
  };
}
