import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

// Observe the existing Node transport without changing fetch, retries or body flow.
// Do not retain error messages, headers, bodies, URLs, addresses or credential data.
const networkCodes = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED',
  'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'ETIMEDOUT', 'ABORT_ERR',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'UND_ERR_DESTROYED', 'UND_ERR_CLOSED', 'UND_ERR_ABORTED',
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function codesOf(error, result = new Set(), seen = new Set()) {
  if (!error || typeof error !== 'object' || seen.has(error) || seen.size >= 12) return [...result];
  seen.add(error);
  const value = (key) => Object.getOwnPropertyDescriptor(error, key)?.value;
  if (networkCodes.has(value('code'))) result.add(value('code'));
  codesOf(value('cause'), result, seen);
  const children = value('errors');
  if (Array.isArray(children)) for (const child of children.slice(0, 8)) codesOf(child, result, seen);
  return [...result];
}

export function observeModelTransport(ctx, publish) {
  const context = new AsyncLocalStorage();
  const requests = new WeakMap();
  const listeners = {
    'undici:request:create': ({ request }) => {
      const scope = context.getStore();
      if (scope) {
        scope.requests += 1;
        const timing = { request: scope.requests, createdMs: Math.round(performance.now() - scope.started) };
        requests.set(request, { scope, timing });
        scope.timings.push(timing);
        scope.report?.('request_created');
      }
    },
    'undici:client:sendHeaders': ({ request }) => {
      const entry = requests.get(request);
      if (entry) entry.timing.sendHeadersMs = Math.round(performance.now() - entry.scope.started);
    },
    'undici:request:bodySent': ({ request }) => {
      const entry = requests.get(request);
      if (entry) {
        entry.timing.bodySentMs = Math.round(performance.now() - entry.scope.started);
        if (entry.timing.request === entry.scope.requests) entry.scope.report?.('request_sent');
      }
    },
    'undici:request:headers': ({ request, response }) => {
      const entry = requests.get(request);
      if (entry && Number.isInteger(response.statusCode)) {
        entry.scope.status = response.statusCode;
        entry.timing.status = response.statusCode;
        entry.timing.headersMs = Math.round(performance.now() - entry.scope.started);
        if (entry.timing.request === entry.scope.requests) entry.scope.report?.('response_headers');
      }
    },
    'undici:request:error': ({ request, error }) => {
      const scope = requests.get(request)?.scope;
      if (scope) for (const code of codesOf(error)) scope.transportCodes.add(code);
    },
  };
  for (const [name, listener] of Object.entries(listeners)) channel(name).subscribe(listener);
  const dispose = ctx.on('llm/stream', (options, next) => {
    const scope = {
      id: randomUUID(), sessionId: options.sessionId, started: performance.now(),
      requests: 0, chunks: 0, transportCodes: new Set(), timings: [],
    };
    const report = (phase, extra = {}) => publish({
      type: 'model_diagnostic', phase, requestId: scope.id,
      ...(typeof scope.sessionId === 'string' ? { sessionId: scope.sessionId } : {}),
      elapsedMs: Math.round(performance.now() - scope.started), requests: scope.requests,
      chunks: scope.chunks, transportCodes: [...scope.transportCodes],
      timings: scope.timings.map(timing => ({ ...timing })),
      ...(scope.status ? { status: scope.status } : {}), ...extra,
    });
    scope.report = report;
    return (async function* () {
      report('start');
      const iterator = context.run(scope, () => next()[Symbol.asyncIterator]());
      let first = false, exhausted = false, failureCode, finishKind;
      let textDeltaChars = 0, reasoningDeltaChars = 0, toolCallBlocks = 0;
      const seen = new Set();
      try {
        while (true) {
          const result = await context.run(scope, () => iterator.next());
          if (result.done) { exhausted = true; return; }
          scope.chunks += 1;
          if (result.value.type === 'text-delta') textDeltaChars += result.value.text.length;
          if (result.value.type === 'reasoning-delta') reasoningDeltaChars += result.value.text.length;
          if (result.value.type === 'block-end' && result.value.block.type === 'tool-call') toolCallBlocks += 1;
          if (result.value.type === 'finish') finishKind = result.value.reason.kind;
          if (!first && ['text-delta', 'reasoning-delta'].includes(result.value.type)) {
            first = true; report('first_chunk');
          }
          if (['text-delta', 'reasoning-delta'].includes(result.value.type) && !seen.has(result.value.type)) {
            seen.add(result.value.type);
            report(result.value.type === 'text-delta' ? 'first_text' : 'first_reasoning');
          }
          if (result.value.type === 'finish' && result.value.reason.kind === 'error') failureCode = result.value.reason.failure.code;
          yield result.value;
        }
      } catch (error) {
        for (const code of codesOf(error)) scope.transportCodes.add(code);
        throw error;
      } finally {
        try { if (!exhausted) await context.run(scope, () => iterator.return?.()); }
        finally { report('end', { textDeltaChars, reasoningDeltaChars, toolCallBlocks, ...(finishKind ? { finishKind } : {}), ...(failureCode ? { failureCode } : {}), cancelled: Boolean(options.signal?.aborted) }); }
      }
    })();
  });
  return () => {
    dispose();
    for (const [name, listener] of Object.entries(listeners)) channel(name).unsubscribe(listener);
    context.disable();
  };
}
