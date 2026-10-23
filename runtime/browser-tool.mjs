export const BROWSER_METHOD = '_codebuddy/browser/control';
export function browserTool({ sessionId, cwd, request }) {
  return {
    name: 'browser_control',
    description: 'Open and control the right-side embedded browser / 右侧浏览器 from this conversation. For a workspace HTML file, call open with path (no shell server needed); this starts a local preview and selects its browser tab. Creating a file alone does not open it. After open, use the returned id with observe or screenshot to verify the page before reporting it displayed. Also supports HTTP(S) URLs, accessible nodes, click, type, key and console. Available to the main agent; delegation is not required. Separate from Playwright MCP. Preview URLs are local, not public deployments.',
    inputSchema: { type: 'object', properties: {
      operation: { type: 'string', enum: ['open', 'observe', 'click', 'type', 'key', 'screenshot', 'console', 'close'] },
      id: { type: 'string', description: 'Tab ID returned by open; required except open.' },
      url: { type: 'string' }, path: { type: 'string', description: 'Workspace HTML path instead of URL.' },
      node: { type: 'integer', minimum: 1, description: 'Backend node ID from latest observation.' },
      text: { type: 'string', maxLength: 20000, description: 'Insert text, without clearing or submitting.' },
      key: { type: 'string', enum: ['Enter', 'Tab', 'Escape', 'Backspace', 'ArrowDown', 'ArrowUp'] },
    }, required: ['operation'], additionalProperties: false },
    async execute(input, { signal } = {}) {
      signal?.throwIfAborted();
      if (input.operation === 'open') {
        if (Boolean(input.url) === Boolean(input.path)) throw Error('Specify exactly one URL or workspace HTML path');
      } else if (!input.id) throw Error('Browser tab ID is required');
      const reply = await request(BROWSER_METHOD, { ...input, scope: { sessionId, root: cwd }, htmlPath: input.path, path: undefined, action: 'browser-control' }, signal);
      if (reply?.error) throw new Error(`Browser operation failed: ${reply.error.message || 'Unknown desktop error'}`);
      if (input.operation === 'open' && (typeof reply?.id !== 'string' || !reply.id ||
          typeof reply?.url !== 'string' || !/^https?:\/\//.test(reply.url)))
        throw new Error('Browser open did not return a loaded tab and preview URL. Do not report it as opened.');
      return reply;
    },
  };
}
