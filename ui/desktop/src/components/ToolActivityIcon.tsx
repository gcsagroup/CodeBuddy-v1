import { FileText, ListChecks, Monitor, Pencil, Search, Terminal, Wrench } from 'lucide-react';
import AnimatedIcons from './AnimatedIcons';
import type { ToolCallStatus } from './ToolCallStatusIndicator';
import { cn } from '../utils';

/** Presentation shared by activity events and tool request/receipt rows. */
export function ToolActivityIcon({ name, status }: { name: string; status: ToolCallStatus }) {
  if (status === 'loading') {
    return <AnimatedIcons className="shrink-0" cycleInterval={300} />;
  }
  const tool = name.split(/__|::/).pop() ?? '';
  // Individual operation failures keep their status text and original detail.
  // The icon describes the operation rather than a second task-level verdict.
  const Icon =
    tool === 'shell'
      ? Terminal
      : tool === 'write' || tool === 'edit'
        ? Pencil
        : tool === 'read_document' || tool === 'read'
          ? FileText
          : tool === 'search' || tool === 'tree' || tool === 'web_search_exa'
            ? Search
            : tool === 'task_contract' || tool === 'todo_write'
              ? ListChecks
              : tool.startsWith('computer_') || tool === 'get_app_state'
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
