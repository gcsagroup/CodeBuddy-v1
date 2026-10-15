import { useEffect, useState } from 'react';
import {
  deleteCodeProMemory,
  exportCodeProMemory,
  listCodeProMemory,
  setCodeProMemoryStatus,
  updateCodeProMemory,
  type CodeProMemoryRecord,
  type ReviewableCodeProMemoryRecord,
} from '../../../acp/memory';
import { defineMessages, useIntl } from '../../../i18n';
import { Button } from '../../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card';

const messages = defineMessages({
  title: { id: 'projectMemoryRecords.title', defaultMessage: 'Saved project memory' },
  description: {
    id: 'projectMemoryRecords.description',
    defaultMessage:
      'Choose a project and review its records. Only approved, unexpired records are recalled in that project.',
  },
  directory: { id: 'projectMemoryRecords.directory', defaultMessage: 'Project directory' },
  load: { id: 'projectMemoryRecords.load', defaultMessage: 'Load records' },
  more: { id: 'projectMemoryRecords.more', defaultMessage: 'Load more' },
  empty: { id: 'projectMemoryRecords.empty', defaultMessage: 'No saved records in this project.' },
  approve: { id: 'projectMemoryRecords.approve', defaultMessage: 'Approve for recall' },
  disable: { id: 'projectMemoryRecords.disable', defaultMessage: 'Disable recall' },
  edit: { id: 'projectMemoryRecords.edit', defaultMessage: 'Edit' },
  save: { id: 'projectMemoryRecords.save', defaultMessage: 'Save changes' },
  cancel: { id: 'projectMemoryRecords.cancel', defaultMessage: 'Cancel' },
  remove: { id: 'projectMemoryRecords.remove', defaultMessage: 'Delete record' },
  confirmRemove: { id: 'projectMemoryRecords.confirmRemove', defaultMessage: 'Confirm deletion' },
  export: { id: 'projectMemoryRecords.export', defaultMessage: 'Export project memory' },
  content: { id: 'projectMemoryRecords.content', defaultMessage: 'Memory content' },
  reason: { id: 'projectMemoryRecords.reason', defaultMessage: 'Reason' },
  changed: {
    id: 'projectMemoryRecords.changed',
    defaultMessage: 'The record changed. Review the refreshed content before approving again.',
  },
  candidate: { id: 'projectMemoryRecords.candidate', defaultMessage: 'Pending review' },
  active: { id: 'projectMemoryRecords.active', defaultMessage: 'Approved' },
  disabled: { id: 'projectMemoryRecords.disabled', defaultMessage: 'Disabled' },
  expired: { id: 'projectMemoryRecords.expired', defaultMessage: 'Expired' },
});

export default function ProjectMemoryRecords() {
  const intl = useIntl();
  const label = (key: keyof typeof messages) => intl.formatMessage(messages[key]);
  const [directory, setDirectory] = useState('');
  const [recent, setRecent] = useState<string[]>([]);
  const [records, setRecords] = useState<CodeProMemoryRecord[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [reason, setReason] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void window.electron
      .listRecentDirs()
      .then((dirs) => {
        if (mounted) setRecent(dirs);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const load = async (next?: string) => {
    const result = await listCodeProMemory(directory.trim(), true, next ? { cursor: next } : {});
    setRecords((previous) => (next ? [...(previous ?? []), ...result.records] : result.records));
    setCursor(result.nextCursor ?? null);
    setEditing(null);
    setDeleting(null);
  };
  const review = async (record: CodeProMemoryRecord) => {
    const result = await setCodeProMemoryStatus({
      workingDir: directory.trim(),
      record: record as ReviewableCodeProMemoryRecord,
      targetStatus: record.status === 'active' ? 'disabled' : 'active',
    });
    await load();
    if (result.outcome === 'needs_review') setError(label('changed'));
  };
  const exportRecords = async () => {
    const result = await exportCodeProMemory(directory.trim(), true);
    const destination = await window.electron.showSaveDialog({
      defaultPath: result.fileName,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!destination.canceled && destination.filePath) {
      const written = await window.electron.writeFile(destination.filePath, result.json);
      if (!written) throw new Error('Memory export could not be saved');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{label('title')}</CardTitle>
        <CardDescription>{label('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="block space-y-2 text-sm">
          {label('directory')}
          <input
            className="w-full rounded border bg-background-primary p-2"
            aria-label={label('directory')}
            list="memory-recent-projects"
            value={directory}
            disabled={busy}
            onChange={(e) => {
              setDirectory(e.target.value);
              setRecords(null);
              setCursor(null);
              setEditing(null);
              setDeleting(null);
              setError(null);
            }}
          />
        </label>
        <datalist id="memory-recent-projects">
          {recent.map((dir) => (
            <option key={dir} value={dir} />
          ))}
        </datalist>
        <div className="flex gap-2">
          <Button disabled={busy || !directory.trim()} onClick={() => void run(() => load())}>
            {label('load')}
          </Button>
          <Button
            variant="outline"
            disabled={busy || records === null}
            onClick={() => void run(exportRecords)}
          >
            {label('export')}
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {error}
          </p>
        )}
        {records?.length === 0 && <p>{label('empty')}</p>}
        {records?.map((record) => (
          <article
            key={record.id}
            className="space-y-2 rounded border p-3"
            aria-label={record.subject}
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-medium">{record.subject}</h3>
              <span className="text-xs">{label(record.expired ? 'expired' : record.status)}</span>
            </div>
            {editing === record.id ? (
              <>
                <label className="block text-sm">
                  {label('content')}
                  <textarea
                    aria-label={label('content')}
                    value={content}
                    maxLength={2000}
                    disabled={busy}
                    onChange={(e) => setContent(e.target.value)}
                    className="mt-1 w-full rounded border bg-background-primary p-2"
                  />
                </label>
                <label className="block text-sm">
                  {label('reason')}
                  <textarea
                    aria-label={label('reason')}
                    value={reason}
                    maxLength={500}
                    disabled={busy}
                    onChange={(e) => setReason(e.target.value)}
                    className="mt-1 w-full rounded border bg-background-primary p-2"
                  />
                </label>
                <Button
                  disabled={busy || !content.trim() || !reason.trim()}
                  onClick={() =>
                    void run(async () => {
                      await updateCodeProMemory({
                        workingDir: directory.trim(),
                        id: record.id,
                        content,
                        reason,
                      });
                      await load();
                    })
                  }
                >
                  {label('save')}
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => setEditing(null)}>
                  {label('cancel')}
                </Button>
              </>
            ) : (
              <>
                <p className="whitespace-pre-wrap break-words text-sm">{record.content}</p>
                <p className="whitespace-pre-wrap break-words text-xs text-text-muted">
                  {record.reason}
                </p>
                {record.sourceRef && (
                  <p className="break-all text-xs text-text-muted">{record.sourceRef}</p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={busy || record.expired || !record.reviewFingerprint}
                    onClick={() => void run(() => review(record))}
                  >
                    {label(record.status === 'active' ? 'disable' : 'approve')}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setEditing(record.id);
                      setContent(record.content);
                      setReason(record.reason);
                      setDeleting(null);
                    }}
                  >
                    {label('edit')}
                  </Button>
                  <Button variant="outline" disabled={busy} onClick={() => setDeleting(record.id)}>
                    {label('remove')}
                  </Button>
                </div>
                {deleting === record.id && (
                  <div className="flex gap-2">
                    <Button
                      variant="destructive"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await deleteCodeProMemory(directory.trim(), record.id);
                          await load();
                        })
                      }
                    >
                      {label('confirmRemove')}
                    </Button>
                    <Button variant="outline" disabled={busy} onClick={() => setDeleting(null)}>
                      {label('cancel')}
                    </Button>
                  </div>
                )}
              </>
            )}
          </article>
        ))}
        {cursor && (
          <Button disabled={busy} onClick={() => void run(() => load(cursor))}>
            {label('more')}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
