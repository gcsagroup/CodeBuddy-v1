import path from 'node:path';
import { registerToolSessionApproval } from './tool-session-approval.mjs';
import { questionForm, questionAnswer } from './user-questions.mjs';

const acceptanceLabels = {
  en: ['The website is ready. Test it in the browser?', 'Start browser testing', 'Just give me the site and launch instructions'],
  simplified: ['网站已准备好，要在浏览器里测试一下吗？', '开始浏览器验收', '只给我网站和启动方法'],
  traditional: ['網站已準備好，要在瀏覽器裡測試一下嗎？', '開始瀏覽器驗收', '只給我網站和啟動方式'],
};
export const BROWSER_METHOD = '_codebuddy/browser/control';
export function browserTool({ sessionId, cwd, request, requestOwner = request, locale = 'zh-CN' }) {
  return registerToolSessionApproval({
    name: 'browser_control',
    description: 'Efficient workflow: open returns freshly read controls and action candidates. Include all known literal textValues in that initial open. For each candidate action pass id (the tab ID), observationId and candidateId together; a candidate ID never replaces the tab ID. Use its returned candidates directly, and use each action’s fresh after-state for the next decision or final result. A final observe, screenshot or console check is unnecessary when returned values already establish the requested outcome. Observe only to resolve missing/pending information; console is for an actual diagnostic need, not routine task completion. Screenshot only unresolved visual content. Do not rediscover this tool once available. For a finished website use offer_acceptance with path or url: asks the user, opens only on approval, otherwise return the site and startup instructions without browser testing. Subsequent opens reuse this conversation’s automation tab. Open and control the right-side embedded browser / 右侧浏览器 from this conversation. Local previews support HTML only, not Markdown, CSV or other document files; use the file read tool to verify those documents. For a workspace HTML file, call open with path (no shell server needed); this starts a local preview and selects its browser tab. Creating an HTML file alone does not open it. After open, inspect its returned observation. If observationError is present or needed content is absent, observe the returned id; use view=page for article/body text. A failed open returns no usable tab ID: do not guess an ID or attempt a screenshot of a failed preview. Also supports HTTP(S) URLs, accessible nodes, click, type, key and console. Available to the main agent; delegation is not required. Separate from Playwright MCP. Preview URLs are local, not public deployments.',
    inputSchema: { type: 'object', properties: {
      operation: { type: 'string', enum: ['offer_acceptance', 'open', 'observe', 'click', 'type', 'key', 'screenshot', 'console', 'close'] },
      id: { type: 'string', description: 'Tab ID returned by a successful open; required except open and offer_acceptance. Never guess an ID after open fails.' },
      url: { type: 'string' }, path: { type: 'string', description: 'Workspace HTML path instead of URL.' },
      node: { type: 'integer', minimum: 1, description: 'Backend node ID from latest observation; required for click and type unless observationId and candidateId are supplied. Prefer a compatible candidate when offered. Click controls, not StaticText children. For a native select, click the desired option and read its value in the returned after-state.' },
      text: { type: 'string', maxLength: 20000, description: 'Insert text, without clearing or submitting. Required for type when the chosen candidate has no valueId. To use literal references instead, include textValues on open (or observe), then choose a candidate with the intended valueId. textValues supplied on an action cannot define its input.' },
      observationId: { type: 'string', description: 'Observation returned by open, observe or an action. Supply together with id and candidateId to bind an action to the observed target.' },
      candidateId: { type: 'string', description: 'Choose a compatible candidate from the latest open, observe or action receipt. Actions return a fresh observation in the last requested view and new candidates in the same receipt. Use that after-state directly; observe again only if pending, incomplete or missing required page detail. verified:false leaves task judgment to you; dispatched does not mean success. Verify field values, selection and status from this control observation. Request a screenshot only when these controls cannot answer a visual question, not as a duplicate check before finishing. If the target is absent, use nextCandidateOffset or reobserve; do not guess a candidate.' },
      view: { type: 'string', enum: ['controls', 'page'], description: 'For open/observe: controls is compact for forms and search; page includes body text. Open defaults to controls; explicit observe defaults to page. Subsequent action receipts retain the selected view until navigation or another explicit observation changes it.' },
      candidateOffset: { type: 'integer', minimum: 0, description: 'For observe only: nextCandidateOffset from the previous candidate page. Each observation invalidates older candidates.' },
      textValues: { type: 'array', maxItems: 24, description: 'For open or observe: original literal texts authorized by the user, with distinct IDs. Type candidates reference a valueId; choosing one inserts the stored literal without rewriting it. Send all known literals on open to avoid a separate registration call. References persist through observations and actions until navigation; [] clears them. Values do not grant permission to write unrelated fields.',
        items: { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 100 }, text: { type: 'string', maxLength: 20000 } }, required: ['id', 'text'], additionalProperties: false } },
      key: { type: 'string', enum: ['Enter', 'Tab', 'Escape', 'Backspace', 'ArrowDown', 'ArrowUp'] },
    }, required: ['operation'], additionalProperties: false },
    async execute(input, { signal } = {}) {
      signal?.throwIfAborted();
      const offer = input.operation === 'offer_acceptance';
      const operation = offer ? 'open' : input.operation;
      let feedback;
      if (operation === 'open') {
        if (Boolean(input.url) === Boolean(input.path)) throw Error('Specify exactly one URL or workspace HTML path');
        if (offer) {
          const [question, yes, no] = /^en/i.test(locale) ? acceptanceLabels.en
            : /Hant|zh-(TW|HK|MO)/i.test(locale) ? acceptanceLabels.traditional : acceptanceLabels.simplified;
          const questions = [{ id: 'browser-acceptance', question, detail: input.path ?? input.url,
            options: [{ label: yes }, { label: no }] }];
          const response = await request('elicitation/create', questionForm(sessionId, questions), signal);
          signal?.throwIfAborted();
          const [answer] = questionAnswer(questions, response).answers;
          feedback = answer.custom;
          if (!answer.selected.includes(yes))
            return { opened: false, ...(input.path ? { path: input.path } : { url: input.url }), ...(feedback ? { feedback } : {}),
              next: 'Do not run browser tests. Deliver the site entry and startup instructions; address any feedback.' };
        }
      } else if (!input.id) throw Error('Browser tab ID is required');
      if (['click', 'type'].includes(input.operation) && !input.candidateId && (!Number.isInteger(input.node) || input.node < 1))
        throw Error(`${input.operation} requires a positive integer node from observe. Include node even when the element is already focused.`);
      const reply = await request(BROWSER_METHOD, { ...input, operation, ...(operation === 'open' ? { reuseAutomationTab: true } : {}), scope: { sessionId, root: cwd }, htmlPath: input.path, path: undefined, action: 'browser-control' }, signal);
      if (reply?.error) throw new Error(`Browser operation failed: ${reply.error.message || 'Unknown desktop error'}`);
      if (operation === 'open' && (typeof reply?.id !== 'string' || !reply.id ||
          typeof reply?.url !== 'string' || !/^https?:\/\//.test(reply.url)))
        throw new Error('Browser open did not return a loaded tab and preview URL. Do not report it as opened.');
      return feedback ? { ...reply, feedback } : reply;
    },
  }, { key: JSON.stringify(['browser_control', sessionId, path.resolve(cwd)]), dependencies: [requestOwner] });
}
