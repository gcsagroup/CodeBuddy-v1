import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { playwrightCli } from './harness/playwright-entry.mjs';
import { registerToolSessionApproval } from './tool-session-approval.mjs';
const require = createRequire(playwrightCli());

export function webAuditTool({ cwd }) {
  return registerToolSessionApproval({
    name: 'web_audit',
    description: 'Run a headless browser accessibility and viewport overflow check on an authorized workspace HTML page. Use after the user authorizes browser acceptance. Reports axe findings, not full accessibility compliance.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, width: { type: 'integer', minimum: 320, maximum: 2560 } }, required: ['path'], additionalProperties: false },
    async execute(args, { signal } = {}) {
      const root = await realpath(cwd), file = await realpath(path.resolve(cwd, args.path)), relative = path.relative(root, file);
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || !/\.html?$/i.test(file)) throw Error('Expected a workspace HTML file');
      signal?.throwIfAborted();
      const browser = await require('playwright').chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true, timeout: 20000 });
      const abort = () => { void browser.close(); };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        signal?.throwIfAborted();
        const page = await browser.newPage({ viewport: { width: args.width ?? 390, height: 844 } });
        await page.goto(pathToFileURL(file).href, { waitUntil: 'load', timeout: 20000 });
        await page.addScriptTag({ path: fileURLToPath(new URL('./assets/axe-core/axe.min.js', import.meta.url)) });
        const findings = await page.evaluate(async () => {
          const result = await window.axe.run();
          return { viewport: { width: innerWidth, documentWidth: document.documentElement.scrollWidth },
            violations: result.violations.map(v=>({ id:v.id, impact:v.impact, description:v.description, helpUrl:v.helpUrl,
              nodes:v.nodes.map(n=>({ target:n.target, failureSummary:n.failureSummary })) })),
            incompleteChecks: result.incomplete.map(v=>v.id) };
        });
        return { ...findings, scope: 'Initial page state only; interactive flows require separate browser checks.' };
      } finally {
        signal?.removeEventListener('abort', abort);
        await browser.close();
      }
    },
  }, { key: JSON.stringify(['web_audit', path.resolve(cwd)]) });
}
