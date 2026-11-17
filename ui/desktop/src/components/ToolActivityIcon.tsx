import { FileSearch, FileText, Film, Globe, ImagePlus, ListChecks, Monitor, Pencil, Search, Terminal, Wrench } from 'lucide-react';
import ThinkingIcon from './ThinkingIcon';
import type { ToolCallStatus } from './ToolCallStatusIndicator';
import { cn } from '../utils';

const writingTools = new Set(['write', 'edit', 'apply_patch', 'write_file']);

function iconForTool(tool: string) {
  if (tool === 'generate_image') return ImagePlus;
  if (tool === 'generate_video') return Film;
  if (['shell', 'pwsh', 'bash', 'exec_command', 'execute', 'run_command'].includes(tool)) return Terminal;
  if (writingTools.has(tool)) return Pencil;
  if (['create_document', 'update_document'].includes(tool)) return Pencil;
  if (['read_document', 'read'].includes(tool)) return FileText;
  if (['read_file', 'view_file', 'open_file'].includes(tool)) return FileSearch;
  if (['web_search_exa', 'tavily_search', 'browse', 'web_open'].includes(tool)) return Globe;
  if (['search', 'tree', 'glob', 'grep', 'search_mcp_tools'].includes(tool)) return Search;
  if (['task_contract', 'todo_write'].includes(tool)) return ListChecks;
  if (tool.startsWith('computer_') || ['get_app_state', 'list_apps', 'perform_secondary_action', 'click', 'drag', 'scroll', 'press_key', 'set_value', 'type_text'].includes(tool)) return Monitor;
  return Wrench;
}

/** Presentation shared by activity events and tool request/receipt rows. */
export function ToolActivityIcon({ name, status, animated = true }: { name: string; status: ToolCallStatus; animated?: boolean }) {
  if (name === 'thinking') return <ThinkingIcon active={status === 'loading'} />;
  const tool = name.split(/__|::/).pop() ?? '';
  // Individual operation failures keep their status text and original detail.
  // The icon describes the operation rather than a second task-level verdict.
  const Icon = iconForTool(tool);
  return (
    <Icon
      aria-hidden="true"
      className={cn(
        'h-4 w-4 shrink-0 text-text-secondary',
        status === 'loading' && animated && 'motion-safe:animate-pulse'
      )}
    />
  );
}
