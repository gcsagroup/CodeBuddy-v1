import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const MODEL = 'codepro-provider-acceptance';
const API_KEY = 'codepro-local-acceptance-key';
const MAX_REQUEST_BYTES = 1_000_000;

function writeJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function credentialValid(request: IncomingMessage) {
  return request.headers.authorization === `Bearer ${API_KEY}`;
}

function trace(
  request: IncomingMessage,
  status: number,
  details: {
    model?: string;
    stream?: boolean;
    authentication?: 'required' | 'not-required';
  } = {}
) {
  console.log(
    `PROVIDER_ACCEPTANCE_TRACE ${JSON.stringify({
      method: request.method,
      path: new URL(request.url ?? '/', 'http://127.0.0.1').pathname,
      status,
      credential: credentialValid(request) ? 'valid' : 'invalid-or-missing',
      ...details,
    })}`
  );
}

function writeStreamingCompletion(response: ServerResponse) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const chunk = (content: string, finishReason: string | null) =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-provider-acceptance',
      object: 'chat.completion.chunk',
      created: 1_788_405_600,
      model: MODEL,
      choices: [{ index: 0, delta: { content }, finish_reason: finishReason }],
    })}\n\n`;
  response.write(chunk('本地连接已成功使用。', null));
  response.write(chunk('', 'stop'));
  response.end('data: [DONE]\n\n');
}

function handleCompletion(request: IncomingMessage, response: ServerResponse) {
  let bytes = 0;
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes <= MAX_REQUEST_BYTES) chunks.push(chunk);
  });
  request.on('end', () => {
    if (bytes > MAX_REQUEST_BYTES) {
      trace(request, 413);
      writeJson(response, 413, { error: { message: 'request too large' } });
      return;
    }
    const credentialWasSupplied = request.headers.authorization !== undefined;
    if (credentialWasSupplied && !credentialValid(request)) {
      trace(request, 401);
      writeJson(response, 401, { error: { message: 'invalid API key' } });
      return;
    }
    let body: { model?: string; stream?: boolean };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      trace(request, 400);
      writeJson(response, 400, { error: { message: 'invalid JSON' } });
      return;
    }
    if (body.model !== MODEL) {
      trace(request, 404, body);
      writeJson(response, 404, { error: { message: 'model not found' } });
      return;
    }
    trace(request, 200, {
      ...body,
      authentication: credentialWasSupplied ? 'required' : 'not-required',
    });
    if (body.stream) {
      writeStreamingCompletion(response);
      return;
    }
    writeJson(response, 200, {
      id: 'chatcmpl-provider-acceptance',
      object: 'chat.completion',
      created: 1_788_405_600,
      model: MODEL,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '本地连接已成功使用。' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
    });
  });
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/api/tags') {
    trace(request, 200, { authentication: 'not-required' });
    writeJson(response, 200, {
      models: [{ name: MODEL, model: MODEL }],
    });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v1/models') {
    if (!credentialValid(request)) {
      trace(request, 401);
      writeJson(response, 401, { error: { message: 'invalid API key' } });
      return;
    }
    trace(request, 200);
    writeJson(response, 200, {
      object: 'list',
      data: [
        {
          id: MODEL,
          object: 'model',
          created: 1_788_405_600,
          owned_by: 'codebuddy-local-acceptance',
          context_window: 128_000,
        },
      ],
    });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
    handleCompletion(request, response);
    return;
  }
  trace(request, 404);
  writeJson(response, 404, { error: { message: 'unsupported route' } });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind local provider');
  console.log(`PROVIDER_ACCEPTANCE_READY http://127.0.0.1:${address.port}`);
});
