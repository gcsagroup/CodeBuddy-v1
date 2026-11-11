// Provider fixtures for unrelated transport tests accept ordinary final answers.
// The dedicated execution-report and zero-action suites exercise rejection.
export function replyToNoActionReview(request, response) {
  const schema = request.tools?.find(tool => tool.function?.name === 'check_execution_claims')?.function;
  if (!schema) return false;
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const delta = { tool_calls: [{ index: 0, id: 'no-action-review', type: 'function', function: {
    name: schema.name, arguments: JSON.stringify({ changes: [], successes: [], ...(schema.parameters?.properties?.executionMissing ? { executionMissing: false } : {}) }),
  } }] };
  response.end('data: ' + JSON.stringify({ id: 'review-fixture', model: request.model,
    choices: [{ index: 0, delta, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n');
  return true;
}
