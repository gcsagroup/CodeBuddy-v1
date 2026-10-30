import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installDocumentRuntimeCompatibility } from './dsh-document-compat.mjs';

const root = new URL(
  '../../../runtime/harness/node_modules/@deepseek-ai/dsh-client-ui-sidebar-documentpreview/',
  import.meta.url
);
const version = '0.2.1-alpha.2';
const chunks = { pdf: 'client.pdf.js', excel: 'client.excel.js', zoom: 'client.js' };
const prefix = 'virtual:codebuddy-dsh-document/';

// XLSX permits omitted sheetFormatPr. The pinned parser then supplies NaN,
// which makes the read-only grid hide every row. Preserve explicit dimensions
// and hidden-row configuration; use the usual 15pt (20px) height only if absent.
export function normalizeExcelPreviewSheets(sheets) {
  return sheets.map((sheet) =>
    Number.isFinite(sheet.defaultRowHeight) && sheet.defaultRowHeight > 0
      ? sheet
      : { ...sheet, defaultRowHeight: 20 }
  );
}

// Adapt the registration envelope and install the standard API missing in
// Electron 41. Upstream rendering algorithms and license notices stay intact.
export function dshDocumentPreviewAssets() {
  return {
    name: 'codebuddy-dsh-document-preview',
    resolveId(id) {
      if (id.startsWith(prefix) && Object.hasOwn(chunks, id.slice(prefix.length))) return '\0' + id;
    },
    load(id) {
      if (!id.startsWith('\0' + prefix)) return;
      const kind = id.slice(prefix.length + 1);
      const chunk = chunks[kind];
      if (!chunk) throw new Error('Unknown document preview chunk');
      const manifest = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'));
      if (manifest.version !== version)
        throw new Error(`Review the document preview adapter before using DSH ${manifest.version}`);
      const file = fileURLToPath(new URL('lib/' + chunk, root));
      this.addWatchFile(file);
      let source = fs.readFileSync(file, 'utf8');
      let compatibility = '';
      if (kind === 'excel') {
        const sheetInput = 'data: state.value.sheets,';
        if (source.split(sheetInput).length !== 2)
          throw new Error('Review changed DSH Excel sheet input');
        source = source.replace(sheetInput, `data: (${normalizeExcelPreviewSheets.toString()})(state.value.sheets),`);
      }
      if (kind === 'pdf') {
        const compatFile = fileURLToPath(new URL('./dsh-document-compat.mjs', import.meta.url));
        this.addWatchFile(compatFile);
        const license = fs.readFileSync(compatFile, 'utf8').match(/^\/\*[\s\S]*?\*\//)?.[0];
        if (!license) throw new Error('Missing document compatibility license');
        compatibility = `${license}\n(${installDocumentRuntimeCompatibility.toString()})();\n`;
        const worker = 'var _dsh_pdf_worker_default = ';
        if (source.split(worker).length !== 2) throw new Error('Review changed DSH PDF worker');
        source = source.replace(worker, worker + JSON.stringify(compatibility) + ' + ');
      }
      if (kind === 'zoom') {
        const regions = [...source.matchAll(/\/\/#region ([^\n]+)\n([\s\S]*?)\/\/#endregion/g)];
        const selected = regions.filter(
          ([, name]) =>
            (name.includes('/zoom/') && !name.endsWith('/store.js')) ||
            name.endsWith('/pdf/locales.js') ||
            name.endsWith('/excel/locales.js')
        );
        if (selected.length !== 8) throw new Error('Review changed DSH zoom/locale regions');
        const locale = (format, language) => {
          const body = selected.find(([, name]) => name.endsWith(`/${format}/locales.js`))?.[2];
          const name = body?.match(new RegExp(`const (${language}(?:\\$\\d+)?) =`))?.[1];
          if (!name) throw new Error('Missing upstream document locale');
          return name;
        };
        return (
          `// Derived from DeepSeek Harness ${version}, MIT. See the bundled package LICENSE.\nexport default { factory: (require) => {\n` +
          `const react = require('react'); const react_jsx_runtime = require('react/jsx-runtime'); const _deepseek_ai_dsh_client_ui_primitives = require('@deepseek-ai/dsh-client-ui-primitives');\n` +
          selected.map(([, , body]) => body).join('\n') +
          `\nreturn { ZoomViewport, zoomSurfaceClass, locales: {pdf: {zh: ${locale('pdf', 'zh')}, en: ${locale('pdf', 'en')}}, excel: {zh: ${locale('excel', 'zh')}, en: ${locale('excel', 'en')}}} }; } };`
        );
      }
      const envelope = 'window.__ModuleLoader__.load({';
      if (!source.includes(envelope) || !source.includes(`chunk: "${chunk}"`))
        throw new Error('Unsupported DSH document preview factory');
      return compatibility + source.replace(envelope, 'export default ({');
    },
  };
}
