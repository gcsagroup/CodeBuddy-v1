import { Pencil, Wrench } from 'lucide-react';
import { useIntl } from '../i18n';
import type { ToolInputPreview as Preview } from '../types/toolInputPreview';
import { formatToolAction } from './toolActionPresentation';

export function formatToolInputPreview(intl: ReturnType<typeof useIntl>, preview: Preview) {
  return formatToolAction(
    intl,
    preview.name,
    {
      __inputPreview: true,
      ...(preview.path ? { file_path: preview.path } : {}),
    },
    'running',
    'headline'
  );
}

// Preparation is an ephemeral, non-interactive row, never a request or receipt.
export function ToolInputPreview({ preview }: { preview: Preview }) {
  const intl = useIntl();
  const Icon = ['write', 'edit', 'text_editor'].includes(preview.name.split(/__|::/).pop() ?? '')
    ? Pencil
    : Wrench;
  return (
    <div role="status" className="my-3 flex min-w-0 items-center gap-2 text-sm text-text-secondary">
      <Icon size={16} className="shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">{formatToolInputPreview(intl, preview)}</span>
    </div>
  );
}
