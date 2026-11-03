import { chunkHasVisibleText, EMPTY_RESPONSE_CODE, isAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import { normalizeGemmaResponse } from './gemma-response.mjs';

// The pinned pi-ai adapter counts reasoning as nonempty content. Validate the
// response at its public seam; native llm-retry retains all recovery authority.
// Remove when the upstream adapter classifies reasoning-only stops itself.
export function installModelResponseValidation(ctx) {
  return ctx.on('llm/stream', (options, next) => {
    if (!isAgentLoopRequest(options)) return next();
    const stream = () => /^gemma-?4(?:[-:]|$)/i.test(options.model?.split('/').at(-1) ?? '')
      ? normalizeGemmaResponse(next()) : next();
    // This provider compatibility check protects direct user answers. Native
    // child and notification turns may legitimately stop without new prose.
    // Use durable origin/source attribution; never infer intent from text.
    const agent = ctx.agents.get(options.sessionId);
    // Native context is appended after the admitted input on first preparation
    // and model switches. It must not hide that input's source attribution.
    const input = options.messages?.findLast(message => message.role === 'user' &&
      !['snapshot', 'catalog', 'instructions'].includes(message.source?.form) &&
      message.source?.kind !== 'model-selection');
    if (!agent || agent.session.header.origin === 'subagent' || input?.source?.kind !== 'user') return stream();
    return (async function* () {
      let productive = false;
      for await (const chunk of stream()) {
        // Content blocks are merge-extensible. Leave other completed block
        // kinds to Harness instead of declaring future media/tool updates empty.
        productive ||= chunkHasVisibleText(chunk) ||
          (chunk.type === 'block-end' && !['text', 'reasoning'].includes(chunk.block.type));
        if (chunk.type === 'finish' && chunk.reason.kind === 'stop' && !productive) {
          yield {
            ...chunk,
            reason: {
              kind: 'error',
              failure: {
                code: EMPTY_RESPONSE_CODE,
                message: 'Model response ended without text or a tool call.',
              },
            },
          };
        } else yield chunk;
      }
    })();
  });
}
