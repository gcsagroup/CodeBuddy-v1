import { createHash } from 'node:crypto';

// Keep Pi's proxy compatibility until a service explicitly rejects tools=[].
// This is wire negotiation within one native call, before any model output.
export const piCompletionsPatch = {
  name: '@earendil-works/pi-ai/api/openai-completions',
  version: '1.2.0',
  packageJson: '../../package.json',
  hash: '5a79cc5aa41dee180692695e65771720d1ea556e9a978649dc2040278be51753',
  transform(source) {
    if (createHash('sha256').update(source).digest('hex') !== piCompletionsPatch.hash)
      throw new Error('Review the locked Pi empty-tools compatibility patch.');
    const previous = 'const { data: openaiStream, response } = await retryProviderRequest(() => client.chat.completions.create(params, requestOptions).withResponse(), {';
    if (source.split(previous).length !== 2)
      throw new Error('Pi empty-tools dispatch boundary changed.');
    // Match the service's validation diagnostic before its echoed input. User
    // text mentioning this error cannot change request handling.
    const rejectionPrefix = "1 validation error:\n  {'type': 'value_error', 'loc': ('body',), 'msg': 'Value error, `tools` must not be an empty array.";
    return source.replace(previous, `let omittedRejectedEmptyTools = false;
            const { data: openaiStream, response } = await retryProviderRequest(async () => {
                try {
                    return await client.chat.completions.create(params, requestOptions).withResponse();
                } catch (error) {
                    const message = error?.error?.message;
                    if (omittedRejectedEmptyTools || !Array.isArray(params.tools) || params.tools.length !== 0 ||
                        error?.status !== 400 || typeof message !== "string" || !message.startsWith(${JSON.stringify(rejectionPrefix)})) throw error;
                    omittedRejectedEmptyTools = true;
                    const { tools: _rejectedEmptyTools, ...withoutEmptyTools } = params;
                    params = withoutEmptyTools;
                    return await client.chat.completions.create(params, requestOptions).withResponse();
                }
            }, {`);
  },
};
