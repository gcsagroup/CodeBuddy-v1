import { FileText, ListChecks, Monitor, Pencil, Search, Terminal, Wrench } from 'lucide-react';
import AnimatedIcons from './AnimatedIcons';
import ThinkingIcon from './ThinkingIcon';
import type { ToolCallStatus } from './ToolCallStatusIndicator';
import { cn } from '../utils';

/** Presentation shared by activity events and tool request/receipt rows. */
export function ToolActivityIcon({ name, status }: { name: string; status: ToolCallStatus }) {
  if (name === 'thinking') return <ThinkingIcon active={status === 'loading'} />;
  if (status === 'loading') {
    return <AnimatedIcons className="shrink-0" />;
  }
  const tool = name.split(/__|::/).pop() ?? '';
  // Individual operation failures keep their status text and original detail.
  // The icon describes the operation rather than a second task-level verdict.
  const Icon = ['shell', 'pwsh', 'bash'].includes(tool)
    ? Terminal
    : tool === 'write' || tool === 'edit'
      ? Pencil
      : tool === 'read_document' || tool === 'read'
        ? FileText
        : [
              'search',
              'tree',
              'glob',
              'grep',
              'search_mcp_tools',
              'web_search_exa',
              'tavily_search',
            ].includes(tool)
          ? Search
          : tool === 'task_contract' || tool === 'todo_write'
            ? ListChecks
            : tool.startsWith('computer_') ||
                [
                  'get_app_state',
                  'list_apps',
                  'perform_secondary_action',
                  'click',
                  'drag',
                  'scroll',
                  'press_key',
                  'set_value',
                  'type_text',
                ].includes(tool)
              ? Monitor
              : Wrench;
  return (
    <Icon
      aria-hidden="true"
      className={cn(
        'h-4 w-4 shrink-0',
        (status === 'error' || status === 'warning') && 'text-text-secondary'
      )}
    />
  );
}
