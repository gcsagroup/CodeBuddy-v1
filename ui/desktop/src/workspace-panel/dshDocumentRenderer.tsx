import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { AlertTriangle, ChevronDown, Plus } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Tooltip, TooltipTrigger, TooltipContent } from '../components/ui/Tooltip';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '../components/ui/dropdown-menu';

// Only presentation primitives are adapted. Upstream PDF.js, text selection,
// zoom gestures, Excel parsing and its read-only grid run unchanged.
function DshTooltip({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
function DshMenu({
  open,
  anchor,
  items,
  selectedId,
  onClose,
  onSelect,
}: {
  open: boolean;
  anchor: React.ReactElement;
  items: { id: string; type?: string; label?: string }[];
  selectedId?: string;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DropdownMenuTrigger asChild onPointerDown={(event) => event.preventDefault()}>
        {anchor}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top">
        {items.map((item) =>
          item.type === 'separator' ? (
            <DropdownMenuSeparator key={item.id} />
          ) : (
            <DropdownMenuItem
              key={item.id}
              onSelect={() => onSelect(item.id)}
              aria-current={item.id === selectedId}
            >
              {item.label}
            </DropdownMenuItem>
          )
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
const primitives = {
  Button,
  Tooltip: DshTooltip,
  Menu: DshMenu,
  IconWarningTriangleOutlineRegular: AlertTriangle,
  IconChevronDownOutlineRegular: ChevronDown,
  IconPlusOutlineRegular: Plus,
};
function requirePresentation(id: string): unknown {
  if (id === 'react') return React;
  if (id === 'react/jsx-runtime') return jsxRuntime;
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
  throw new Error(`Unsupported document renderer dependency: ${id}`);
}
type Copy = (key: string, values?: Record<string, string | number>) => string;
type Content = { kind: 'bytes'; data: Uint8Array<ArrayBuffer> };
export interface DshExcelProps {
  content: Content;
  format: 'xlsx';
  limits: { maxBytes: number; maxCells: number; timeoutMs: number };
  t: Copy;
  loading: React.ReactNode;
}
export interface DshPdfProps {
  [key: string]: unknown;
  content: Content;
}
const excelLimits = { maxBytes: 16 * 1024 * 1024, maxCells: 250000, timeoutMs: 15000 };
const modules = {
  pdf: () =>
    import('virtual:codebuddy-dsh-document/pdf').then((m) =>
      m.default.factory(requirePresentation)
    ),
  excel: () =>
    import('virtual:codebuddy-dsh-document/excel').then((m) =>
      m.default.factory(requirePresentation)
    ),
  zoom: () =>
    import('virtual:codebuddy-dsh-document/zoom').then((m) =>
      m.default.factory(requirePresentation)
    ),
};
let pdf: ReturnType<typeof modules.pdf> | undefined;
let excel: ReturnType<typeof modules.excel> | undefined;
let zoom: ReturnType<typeof modules.zoom> | undefined;
export async function loadDshDocumentRenderer(kind: 'pdf' | 'excel') {
  zoom ??= modules.zoom().catch((e) => {
    zoom = undefined;
    throw e;
  });
  if (kind === 'pdf')
    pdf ??= modules.pdf().catch((e) => {
      pdf = undefined;
      throw e;
    });
  else
    excel ??= modules.excel().catch((e) => {
      excel = undefined;
      throw e;
    });
  const [controls, renderer] = await Promise.all([zoom, kind === 'pdf' ? pdf! : excel!]);
  return { ...controls, ...renderer };
}
type Renderer = Awaited<ReturnType<typeof loadDshDocumentRenderer>>;
export interface DocumentView {
  page: number;
  zoom?: { kind: 'fit-width' } | { kind: 'fixed'; scale: number };
}
export function DshDocumentRenderer({
  renderer,
  kind,
  data,
  locale,
  id,
  signal,
  loading,
  view,
  onViewChange,
}: {
  renderer: Renderer;
  kind: 'pdf' | 'excel';
  data: Uint8Array<ArrayBuffer>;
  locale: string;
  id: string;
  signal: AbortSignal;
  loading: React.ReactNode;
  view: DocumentView;
  onViewChange: (view: DocumentView) => void;
}) {
  const content = React.useMemo<Content>(() => ({ kind: 'bytes', data }), [data]);
  const dictionary = renderer.locales[kind][locale.startsWith('zh') ? 'zh' : 'en'];
  const t = React.useCallback<Copy>(
    (key, values) =>
      (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) =>
        String(values?.[name] ?? match)
      ),
    [dictionary]
  );
  const current = React.useRef({ view, onViewChange });
  current.current = { view, onViewChange };
  const actions = React.useMemo(
    () => ({
      page: (_id: string, page: number) => {
        const c = current.current;
        if (c.view.page !== page) c.onViewChange({ ...c.view, page });
      },
      zoom: (_id: string, value: DocumentView['zoom']) => {
        const c = current.current;
        c.onViewChange({ ...c.view, zoom: value });
      },
    }),
    []
  );
  const useTabInfo = React.useCallback(() => ({ tab: { id, signal } }), [id, signal]);
  const useStore = <T,>(selector: (state: { byTab: Record<string, DocumentView> }) => T) =>
    selector({ byTab: { [id]: view } });
  const retainTab = React.useCallback(() => {}, []);
  const scrollportRef = React.useCallback(() => {}, []);
  if (kind === 'excel' && 'ExcelBody' in renderer)
    return (
      <renderer.ExcelBody
        content={content}
        format="xlsx"
        limits={excelLimits}
        t={t}
        loading={loading}
      />
    );
  if (kind === 'pdf' && 'PdfBody' in renderer)
    return (
      <renderer.PdfBody
        content={content}
        useTabInfo={useTabInfo}
        useStore={useStore}
        actions={actions}
        retainTab={retainTab}
        ZoomViewport={renderer.ZoomViewport}
        zoomSurfaceClass={renderer.zoomSurfaceClass}
        scrollportRef={scrollportRef}
        t={t}
        loading={loading}
      />
    );
  throw new Error('Document renderer does not match its format');
}
