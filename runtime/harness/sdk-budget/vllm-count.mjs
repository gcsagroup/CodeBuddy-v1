import { channel } from 'node:diagnostics_channel';

export const requestBudgetChannel = channel('codebuddy.request-budget');
export const streamingOutputChannel = channel('codebuddy.streaming-output-count');

// vLLM's chat tokenizer renders messages, tool definitions and template kwargs.
// Fields that select a different renderer cannot be silently treated as counted.
export async function countVllmInput(baseUrl, payload, headers, signal) {
  const url = new URL(baseUrl);
  if (!/\/v1\/?$/.test(url.pathname) || url.search || url.hash || payload.reasoning_effort ||
      payload.thinking || payload.chat_template_args || payload.enable_thinking !== undefined || payload.tool_choice) return;
  url.pathname = url.pathname.replace(/\/v1\/?$/, '/tokenize');
  const body = {};
  for (const key of ['model', 'messages', 'tools', 'chat_template', 'chat_template_kwargs', 'add_generation_prompt',
    'continue_final_message', 'add_special_tokens', 'mm_processor_kwargs', 'media_io_kwargs'])
    if (payload[key] !== undefined) body[key] = payload[key];
  const timeout = AbortSignal.timeout(8000);
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!res.ok) { await res.body?.cancel(); return; }
    const buffers = [];
    let bytes = 0;
    for await (const part of res.body) {
      bytes += part.length;
      if (bytes > 16 * 1024 * 1024) return;
      buffers.push(part);
    }
    const { count, max_model_len: limit } = JSON.parse(Buffer.concat(buffers).toString());
    if (Number.isSafeInteger(count) && count > 0 && Number.isSafeInteger(limit) && limit > 0) return { count, limit };
  } catch { signal?.throwIfAborted(); }
}
