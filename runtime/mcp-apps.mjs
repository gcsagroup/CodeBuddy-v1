import { invalid, requireString } from './providers.mjs';

const methods = new Set(['resources/read', 'apps/list', 'apps/import', 'apps/export', 'apps/delete']);
const MIME = 'text/html;profile=mcp-app';
const MAX_HTML = 16 * 1024 * 1024, MAX_CACHE = 64 * 1024 * 1024;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const htmlSize = value => Buffer.byteLength(value, 'utf8');

function validateHtml(html) {
  if (typeof html !== 'string' || !html.trim() || htmlSize(html) > MAX_HTML) throw invalid('App HTML must contain 1 to 16777216 UTF-8 bytes');
  return html;
}
function scriptPattern(type) {
  // This parses a known export envelope, never instructions or task intent.
  return new RegExp(`<script\\b(?=[^>]*\\btype\\s*=\\s*(["'])${type.replaceAll('+', '\\+')}\\1)[^>]*>([\\s\\S]*?)<\\/script\\s*>`, 'i');
}
export function parseAppHtml(html) {
  validateHtml(html);
  const metadataPattern = scriptPattern('application/ld+json'), metadata = metadataPattern.exec(html);
  if (!metadata) throw invalid('No GooseApp JSON-LD metadata found in HTML');
  let fields;
  try { fields = JSON.parse(metadata[2]); } catch { throw invalid('Invalid GooseApp JSON-LD metadata'); }
  if (!isObject(fields) || typeof fields.name !== 'string' || !fields.name.trim() || fields.name.length > 256) throw invalid('App metadata requires a name of 1 to 256 characters');
  const app = { name: fields.name, uri: `ui://apps/${fields.name}`, mimeType: MIME, mcpServers: ['apps'], deletable: true };
  if (fields.description !== undefined) { if (typeof fields.description !== 'string' || fields.description.length > 16_384) throw invalid('Invalid app description'); app.description = fields.description; }
  if (['width', 'height', 'resizable'].some(key => fields[key] !== undefined)) {
    for (const key of ['width', 'height']) if (fields[key] !== undefined && (!Number.isSafeInteger(fields[key]) || fields[key] < 1 || fields[key] > 16_384)) throw invalid(`Invalid app ${key}`);
    if (fields.resizable !== undefined && typeof fields.resizable !== 'boolean') throw invalid('Invalid app resizable');
    Object.assign(app, { width: fields.width ?? 800, height: fields.height ?? 600, resizable: fields.resizable ?? true });
  }
  // Exported resource policy remains data; only the sandbox translates CSP.
  if (fields._meta !== undefined) { if (!isObject(fields._meta)) throw invalid('Invalid app metadata'); app._meta = clone(fields._meta); }
  const prdPattern = scriptPattern('application/x-goose-prd'), prd = prdPattern.exec(html);
  if (prd) app.prd = prd[2].trim();
  app.text = html.replace(metadataPattern, '').replace(prdPattern, '');
  return app;
}
export function exportAppHtml(app) {
  const html = validateHtml(app.text ?? (app.blob ? Buffer.from(app.blob, 'base64').toString('utf8') : ''));
  const fields = { '@context': 'urn:goose.ai:schema', '@type': 'GooseApp', name: app.name };
  for (const key of ['description', 'width', 'height', 'resizable', 'mcpServers', '_meta']) if (app[key] !== undefined) fields[key] = clone(app[key]);
  // A display name or CSP string must never close its JSON script element.
  const json = JSON.stringify(fields, null, 2).replaceAll('<', '\\u003c');
  const metadata = `<script type="application/ld+json">${json}</script>`;
  const prd = app.prd ? `<script type="application/x-goose-prd">${app.prd.replace(/<\/script/gi, '<\\/script')}</script>` : '';
  return /<\/head\s*>/i.test(html) ? html.replace(/<\/head\s*>/i, `${metadata}${prd}</head>`) : `${metadata}${prd}${html}`;
}

/** Frozen ACP app/resource envelope; all remote I/O stays on the session's Harness connection. */
export class McpApps {
  constructor(store, { resolveContext }) { this.store = store; this.resolveContext = resolveContext; }
  handles(method) { return methods.has(method); }
  initialize() { return this.initialization ??= this.store.update(state => { state.mcpApps ??= { local: [], remote: [] }; }); }
  async request(method, params = {}) {
    if (!this.handles(method)) return undefined;
    await this.initialize();
    if (method === 'apps/import') return this.import(params.html);
    if (method === 'apps/delete') return this.delete(params.name);
    if (method === 'apps/export') {
      requireString(params.name, 'name');
      const apps = this.apps().filter(app => app.name === params.name);
      if (apps.length !== 1) throw invalid(apps.length ? 'App name is ambiguous' : 'App not found');
      return { html: exportAppHtml(apps[0]) };
    }
    if (method === 'apps/list') {
      if (params.sessionId) await this.refresh(params.sessionId);
      return { apps: this.apps() };
    }
    requireString(params.sessionId, 'sessionId'); requireString(params.extensionName, 'extensionName'); requireString(params.uri, 'uri');
    const context = await this.resolveContext(params.sessionId);
    if (params.extensionName === 'apps') {
      const app = this.store.read().mcpApps.local.find(item => item.uri === params.uri);
      if (!app) throw invalid('App resource not found');
      const { text, uri, mimeType, _meta } = app;
      return { result: { contents: [{ text, uri, mimeType, ...(_meta ? { _meta } : {}) }] } };
    }
    if (!context.extensions.includes(params.extensionName)) throw invalid('MCP resource extension is not enabled in this session');
    return { result: await context.readResource(params.extensionName, params.uri) };
  }
  apps() { const { local, remote } = this.store.read().mcpApps; return [...local, ...remote.map(item => item.app)]; }
  import(html) {
    const app = parseAppHtml(html);
    return this.store.update(state => {
      const names = new Set([...state.mcpApps.local, ...state.mcpApps.remote.map(item => item.app)].map(item => item.name.toLowerCase()));
      const base = app.name; let suffix = 1;
      while (names.has(app.name.toLowerCase())) app.name = `${base}_${suffix++}`;
      app.uri = `ui://apps/${app.name}`;
      if (state.mcpApps.local.length >= 256 || htmlSize(JSON.stringify([...state.mcpApps.local, app])) > MAX_CACHE) throw invalid('Local app storage limit reached');
      state.mcpApps.local.push(app);
      return { name: app.name, message: 'App imported successfully' };
    });
  }
  delete(name) {
    requireString(name, 'name');
    return this.store.update(state => {
      const index = state.mcpApps.local.findIndex(app => app.name === name);
      if (index < 0) throw invalid('Only imported local apps can be deleted');
      state.mcpApps.local.splice(index, 1);
      return { name, message: 'App deleted successfully' };
    });
  }
  async refresh(sessionId) {
    const context = await this.resolveContext(sessionId), remote = [];
    for (const extension of context.extensions) {
      let cursor; const cursors = new Set();
      do {
        const result = await context.listResources(extension, cursor);
        for (const resource of result.resources ?? []) {
          if (typeof resource.uri !== 'string' || !resource.uri.startsWith('ui://') || !(resource.mimeType ?? '').startsWith('text/html')) continue;
          if (remote.length >= 256) throw invalid('MCP app resource limit reached');
          const read = await context.readResource(extension, resource.uri), content = read.contents?.find(item => item.uri === resource.uri) ?? read.contents?.[0];
          if (!isObject(content)) throw invalid('MCP app resource returned no content');
          const text = content.text ?? (typeof content.blob === 'string' ? Buffer.from(content.blob, 'base64').toString('utf8') : undefined);
          validateHtml(text);
          const app = { ...clone(resource), ...clone(content), text, name: resource.name ?? resource.uri, mimeType: content.mimeType ?? resource.mimeType, mcpServers: [extension], deletable: false };
          delete app.blob;
          remote.push({ extension, app });
          if (htmlSize(JSON.stringify(remote)) > MAX_CACHE) throw invalid('MCP app cache limit reached');
        }
        cursor = result.nextCursor;
        if (cursor !== undefined && (typeof cursor !== 'string' || cursors.has(cursor) || cursors.size >= 64)) throw invalid('Invalid MCP resource pagination');
        if (cursor !== undefined) cursors.add(cursor);
      } while (cursor !== undefined);
    }
    await this.store.update(state => {
      // Refresh only selected servers, retaining offline cached app cards from others.
      state.mcpApps.remote = [...state.mcpApps.remote.filter(item => !context.extensions.includes(item.extension)), ...remote];
      if (htmlSize(JSON.stringify(state.mcpApps.remote)) > MAX_CACHE) throw invalid('MCP app cache limit reached');
    });
  }
}
