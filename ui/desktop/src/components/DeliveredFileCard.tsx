import type { ReactNode } from 'react';
import { ChevronDown, FileText, FileSpreadsheet, File, Presentation } from 'lucide-react';
import { useIntl } from '../i18n';
import { panelMessages } from '../workspace-panel/workspacePanelMessages';
import { openWorkspaceFile } from '../workspace-panel/workspaceFilePanel';
import './deliveredFileCard.css';

export function DeliveredFileCard({
  sessionId,
  path,
  children,
}: {
  sessionId: string;
  path: string;
  children: ReactNode;
}) {
  const intl = useIntl();
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  const spreadsheet = ['xlsx', 'xls', 'csv', 'tsv'].includes(extension);
  const Icon = spreadsheet
    ? FileSpreadsheet
    : ['pptx', 'ppt'].includes(extension)
      ? Presentation
      : ['md', 'mdx', 'markdown', 'txt', 'pdf', 'docx', 'doc'].includes(extension)
        ? FileText
        : File;
  const format =
    (
      {
        xlsx: 'Excel',
        xls: 'Excel',
        md: 'Markdown',
        mdx: 'Markdown',
        markdown: 'Markdown',
        docx: 'Word',
        doc: 'Word',
        pptx: 'PowerPoint',
        ppt: 'PowerPoint',
      } as Record<string, string>
    )[extension] ?? extension.toUpperCase();
  return (
    <div className="delivered-file-card" data-file-path={path}>
      <span
        className={`delivered-file-icon ${spreadsheet ? 'delivered-file-sheet' : ''}`}
        aria-hidden="true"
      >
        <Icon size={24} />
      </span>
      <div className="delivered-file-name" title={path}>
        {children}
        <span className="delivered-file-format">{format}</span>
      </div>
      <button
        type="button"
        className="delivered-file-open"
        onClick={() => openWorkspaceFile({ sessionId, filePath: path, action: 'file-menu' })}
      >
        {intl.formatMessage(panelMessages.openWith)}
        <ChevronDown size={14} />
      </button>
    </div>
  );
}
