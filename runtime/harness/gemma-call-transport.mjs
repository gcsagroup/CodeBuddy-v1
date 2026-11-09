import { createHash } from 'node:crypto';

// Retry scheduling stays in Harness. A previously rejected request can ask the
// same endpoint for its complete message, avoiding the provider's broken SSE
// identity fragments. Keep only a bounded per-session digest of failed input.
const failures = new WeakMap();
export function gemmaCallTransport(adapter, model, sessionId) {
  if (!sessionId || model.api !== 'openai-completions' ||
      !/^gemma-?4(?:[-:]|$)/i.test(model.id?.split('/').at(-1) ?? '')) return;
  let sessions = failures.get(adapter);
  if (!sessions) failures.set(adapter, sessions = new Map());
  let body;
  const digest = () => createHash('sha256').update(model.baseUrl).update(body).digest('hex');
  return {
    rejectIncompleteCall() {
      if (!body) return;
      if (sessions.size >= 128) sessions.delete(sessions.keys().next().value);
      sessions.set(sessionId, digest());
    },
    async fetch(url, init) {
      body = init?.body;
      const previous = sessions.get(sessionId);
      sessions.delete(sessionId);
      if (!previous || typeof body !== 'string' || previous !== digest()) return fetch(url, init);
      const payload = JSON.parse(body);
      payload.stream = false;
      delete payload.stream_options;
      const response = await fetch(url, { ...init, body: JSON.stringify(payload) });
      if (!response.ok || response.headers.get('content-type')?.includes('text/event-stream')) return response;
      const completion = await response.json();
      const choice = completion.choices?.[0];
      if (!choice?.message || !choice.finish_reason) throw new Error('Gemma returned an incomplete chat completion.');
      // Reuse Pi's standard content, reasoning, usage and parallel-call parser.
      // All tool names, arguments and IDs must come from the provider.
      const delta = { ...choice.message };
      if (Array.isArray(delta.tool_calls)) delta.tool_calls = delta.tool_calls.map((call, index) => ({ ...call, index }));
      const frame = { id: completion.id, model: completion.model, usage: completion.usage,
        choices: [{ index: choice.index, delta, finish_reason: choice.finish_reason }] };
      const headers = new Headers(response.headers);
      headers.delete('content-length');
      headers.delete('content-encoding');
      headers.set('content-type', 'text/event-stream');
      return new Response('data: ' + JSON.stringify(frame) + '\n\ndata: [DONE]\n\n', { headers });
    },
  };
}
