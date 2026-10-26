import path from 'node:path';
import { registerToolSessionApproval } from './tool-session-approval.mjs';
export const BROWSER_METHOD = '_codebuddy/browser/control';
export function browserTool({ sessionId, cwd, request, requestOwner = request }) {
  return registerToolSessionApproval({
    name: 'browser_control',
    description: 'Open and control the right-side embedded browser / 右侧浏览器 from this conversation. Local previews support HTML only, not Markdown, CSV or other document files; use the file read tool to verify those documents. For a workspace HTML file, call open with path (no shell server needed); this starts a local preview and selects its browser tab. Creating an HTML file alone does not open it. After a successful open, use the returned id with observe or screenshot to verify the page before reporting it displayed. A failed open returns no usable tab ID: do not guess an ID or attempt a screenshot of a failed preview. Also supports HTTP(S) URLs, accessible nodes, click, type, key and console. Available to the main agent; delegation is not required. Separate from Playwright MCP. Preview URLs are local, not public deployments.',
    inputSchema: { type: 'object', properties: {
      operation: { type: 'string', enum: ['open', 'observe', 'click', 'type', 'key', 'screenshot', 'console', 'close'] },
      id: { type: 'string', description: 'Tab ID returned by a successful open; required except open. Never guess an ID after open fails.' },
      url: { type: 'string' }, path: { type: 'string', description: 'Workspace HTML path instead of URL.' },
      node: { type: 'integer', minimum: 1, description: 'Required for BOTH click and type: backend node ID from latest observation. Focusing an element does not replace this argument. Click buttons, links or form controls, not their StaticText children. For a native select, click the desired option node directly; keyboard popup navigation is platform dependent. Observe the value after selection.' },
      text: { type: 'string', maxLength: 20000, description: 'Insert text, without clearing or submitting.' },
      key: { type: 'string', enum: ['Enter', 'Tab', 'Escape', 'Backspace', 'ArrowDown', 'ArrowUp'] },
    }, required: ['operation'], additionalProperties: false },
    async execute(input, { signal } = {}) {
      signal?.throwIfAborted();
      if (input.operation === 'open') {
        if (Boolean(input.url) === Boolean(input.path)) throw Error('Specify exactly one URL or workspace HTML path');
      } else if (!input.id) throw Error('Browser tab ID is required');
      if (['click', 'type'].includes(input.operation) && (!Number.isInteger(input.node) || input.node < 1))
        throw Error(`${input.operation} requires a positive integer node from observe. Include node even when the element is already focused.`);
      const reply = await request(BROWSER_METHOD, { ...input, scope: { sessionId, root: cwd }, htmlPath: input.path, path: undefined, action: 'browser-control' }, signal);
      if (reply?.error) throw new Error(`Browser operation failed: ${reply.error.message || 'Unknown desktop error'}`);
      if (input.operation === 'open' && (typeof reply?.id !== 'string' || !reply.id ||
          typeof reply?.url !== 'string' || !/^https?:\/\//.test(reply.url)))
        throw new Error('Browser open did not return a loaded tab and preview URL. Do not report it as opened.');
      return reply;
    },
  }, { key: JSON.stringify(['browser_control', sessionId, path.resolve(cwd)]), dependencies: [requestOwner] });
}
