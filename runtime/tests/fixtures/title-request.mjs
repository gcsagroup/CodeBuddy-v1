// Auxiliary title requests are not task-model/tool requests.
export function answerTitleRequest(body, res) {
  const system = body.messages?.[0]?.content;
  if (typeof system !== 'string' || !['Summarize the supplied first conversation turn', 'Title the user’s topic and action'].some(prefix => system.startsWith(prefix))) return false;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ id: 'title', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: 'Role integration' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  return true;
}
