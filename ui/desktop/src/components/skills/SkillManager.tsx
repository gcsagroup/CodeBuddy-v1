import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  AlertCircle,
  Copy,
  Download,
  FilePenLine,
  FolderInput,
  Power,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import type { IntlShape } from 'react-intl';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { SourceEntry } from '@aaif/goose-sdk';
import { defineMessages, useIntl } from '../../i18n';
import { getInitialWorkingDir } from '../../utils/workingDir';
import { errorMessage } from '../../utils/conversionUtils';
import { MainPanelLayout } from '../Layout/MainPanelLayout';
import { SearchView } from '../conversation/SearchView';
import { getSearchShortcutText } from '../../utils/keyboardShortcuts';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { ConfirmationModal } from '../ui/ConfirmationModal';
import {
  applySkillChange,
  listManagedSkills,
  listSkillRecoveries,
  previewSkillChange,
  previewSkillDownload,
  skillManagementErrorReason,
  type ManagedSkill,
  type SkillDestinationRoot,
  type SkillManagementOperation,
  type SkillManagementPreview,
  type SkillRecoveryEntry,
} from '../../acp/skillManagement';
import {
  getSkillManagementConfirmationsSnapshot,
  resolveSkillManagementConfirmation,
  subscribeSkillManagementConfirmations,
} from '../../acp/skillConfirmationRequests';

const i18n = defineMessages({
  title: { id: 'skillManager.title', defaultMessage: 'Skills' },
  description: {
    id: 'skillManager.description',
    defaultMessage: 'Create, import, edit, copy, delete, and restore skills. {shortcut} to search.',
  },
  search: { id: 'skillManager.search', defaultMessage: 'Search skills...' },
  create: { id: 'skillManager.create', defaultMessage: 'Create skill' },
  importLocal: { id: 'skillManager.importLocal', defaultMessage: 'Import local skill' },
  download: { id: 'skillManager.download', defaultMessage: 'Download from link' },
  edit: { id: 'skillManager.edit', defaultMessage: 'Edit' },
  copy: { id: 'skillManager.copy', defaultMessage: 'Copy' },
  delete: { id: 'skillManager.delete', defaultMessage: 'Delete' },
  enable: { id: 'skillManager.enable', defaultMessage: 'Enable' },
  disable: { id: 'skillManager.disable', defaultMessage: 'Disable' },
  enabled: { id: 'skillManager.enabled', defaultMessage: 'Enabled' },
  disabled: { id: 'skillManager.disabled', defaultMessage: 'Disabled' },
  restore: { id: 'skillManager.restore', defaultMessage: 'Restore' },
  details: { id: 'skillManager.details', defaultMessage: 'Skill details' },
  use: { id: 'skillManager.use', defaultMessage: 'Use skill' },
  close: { id: 'skillManager.close', defaultMessage: 'Close' },
  source: { id: 'skillManager.source', defaultMessage: 'Source' },
  content: { id: 'skillManager.content', defaultMessage: 'Instructions' },
  loading: { id: 'skillManager.loading', defaultMessage: 'Loading skills...' },
  empty: { id: 'skillManager.empty', defaultMessage: 'No skills installed' },
  noMatch: { id: 'skillManager.noMatch', defaultMessage: 'No matching skills found' },
  retry: { id: 'skillManager.retry', defaultMessage: 'Try again' },
  readOnly: { id: 'skillManager.readOnly', defaultMessage: 'Read only' },
  global: { id: 'skillManager.scope.global', defaultMessage: 'Global' },
  project: { id: 'skillManager.scope.project', defaultMessage: 'Project' },
  plugin: { id: 'skillManager.scope.plugin', defaultMessage: 'Plugin' },
  builtin: { id: 'skillManager.scope.builtin', defaultMessage: 'Built in' },
  name: { id: 'skillManager.name', defaultMessage: 'Skill name' },
  nameHelp: {
    id: 'skillManager.nameHelp',
    defaultMessage: 'Use lowercase letters, numbers, and hyphens.',
  },
  destination: { id: 'skillManager.destination', defaultMessage: 'Install location' },
  descriptionLabel: { id: 'skillManager.descriptionLabel', defaultMessage: 'Description' },
  instructions: { id: 'skillManager.instructions', defaultMessage: 'Instructions' },
  document: { id: 'skillManager.document', defaultMessage: 'SKILL.md content' },
  sourcePath: { id: 'skillManager.sourcePath', defaultMessage: 'SKILL.md or skill folder' },
  downloadUrl: {
    id: 'skillManager.downloadUrl',
    defaultMessage: 'GitHub skill directory or HTTPS SKILL.md link',
  },
  browse: { id: 'skillManager.browse', defaultMessage: 'Browse...' },
  cancel: { id: 'skillManager.cancel', defaultMessage: 'Cancel' },
  continue: { id: 'skillManager.continue', defaultMessage: 'Review change' },
  save: { id: 'skillManager.save', defaultMessage: 'Apply change' },
  previewTitle: { id: 'skillManager.previewTitle', defaultMessage: 'Review skill change' },
  previewTarget: { id: 'skillManager.previewTarget', defaultMessage: 'Target: {target}' },
  previewFiles: { id: 'skillManager.previewFiles', defaultMessage: 'Files: {files}' },
  deleteTitle: { id: 'skillManager.deleteTitle', defaultMessage: 'Delete skill?' },
  deleteMessage: {
    id: 'skillManager.deleteMessage',
    defaultMessage: 'Move “{target}” to recoverable storage?',
  },
  confirmDelete: { id: 'skillManager.confirmDelete', defaultMessage: 'Confirm delete' },
  recovered: { id: 'skillManager.recovered', defaultMessage: 'Recently deleted' },
  failed: { id: 'skillManager.failed', defaultMessage: 'Skill operation failed' },
  failedWithDetail: {
    id: 'skillManager.failedWithDetail',
    defaultMessage: 'Skill operation failed: {detail}',
  },
  reasonProjectNotFound: {
    id: 'skillManager.error.projectNotFound',
    defaultMessage: 'The project folder no longer exists.',
  },
  reasonSourceNotFound: {
    id: 'skillManager.error.sourceNotFound',
    defaultMessage: 'The skill no longer exists. Refresh and try again.',
  },
  reasonReadOnly: {
    id: 'skillManager.error.readOnly',
    defaultMessage: 'This skill is read only. Copy it before editing.',
  },
  reasonStale: {
    id: 'skillManager.error.stale',
    defaultMessage: 'The skill changed. Refresh and review it again.',
  },
  reasonExpired: {
    id: 'skillManager.error.expired',
    defaultMessage: 'The preview expired. Review the change again.',
  },
  reasonCancelled: {
    id: 'skillManager.error.cancelled',
    defaultMessage: 'The operation was cancelled.',
  },
  reasonInvalidDocument: {
    id: 'skillManager.error.invalidDocument',
    defaultMessage: 'SKILL.md has invalid or incomplete frontmatter.',
  },
  reasonNameMismatch: {
    id: 'skillManager.error.nameMismatch',
    defaultMessage: 'The folder name and skill name must match.',
  },
  reasonImportNotFound: {
    id: 'skillManager.error.importNotFound',
    defaultMessage: 'The selected skill file or folder was not found.',
  },
  reasonUnsupportedImport: {
    id: 'skillManager.error.unsupportedImport',
    defaultMessage: 'Select a SKILL.md file or a skill folder.',
  },
  reasonLinkedPath: {
    id: 'skillManager.error.linkedPath',
    defaultMessage: 'Linked files are not allowed in imported skills.',
  },
  reasonConflict: {
    id: 'skillManager.error.destinationConflict',
    defaultMessage: 'The destination already contains a skill with this name.',
  },
  reasonRecoveryNotFound: {
    id: 'skillManager.error.recoveryNotFound',
    defaultMessage: 'The recovery item is no longer available.',
  },
  reasonUnsafeDownload: {
    id: 'skillManager.error.unsafeDownload',
    defaultMessage:
      'Use a public HTTPS skill link. Local and private network addresses are blocked.',
  },
  reasonUnsupportedDownload: {
    id: 'skillManager.error.unsupportedDownload',
    defaultMessage: 'Use a GitHub skill directory or a direct HTTPS SKILL.md link.',
  },
  reasonDownloadLimit: {
    id: 'skillManager.error.downloadLimit',
    defaultMessage: 'The downloaded skill exceeds the allowed file count or size.',
  },
  reasonDownloadFailed: {
    id: 'skillManager.error.downloadFailed',
    defaultMessage: 'The skill could not be downloaded or validated.',
  },
});

export function localizeKnownBuiltInSkill(
  source: Pick<SourceEntry, 'name' | 'description'>,
  _intl: IntlShape
) {
  return { name: source.name, description: source.description };
}

export function localizeSkillEntry(source: SourceEntry, intl: IntlShape) {
  return source.type === 'builtinSkill'
    ? localizeKnownBuiltInSkill(source, intl)
    : { name: source.name, description: source.description };
}

export function getSkillsLoadError(error: unknown, intl: IntlShape): string {
  const detail =
    typeof error === 'string' ? error : error instanceof Error ? errorMessage(error, '') : '';
  return detail
    ? intl.formatMessage(i18n.failedWithDetail, { detail })
    : intl.formatMessage(i18n.failed);
}

function localizedError(error: unknown, intl: IntlShape): string {
  const reason = skillManagementErrorReason(error);
  if (reason === 'unknown') return getSkillsLoadError(error, intl);
  const descriptor = {
    project_not_found: i18n.reasonProjectNotFound,
    source_not_found: i18n.reasonSourceNotFound,
    source_scope_mismatch: i18n.reasonSourceNotFound,
    read_only: i18n.reasonReadOnly,
    stale_source: i18n.reasonStale,
    filesystem_identity_changed: i18n.reasonStale,
    stale_import_source: i18n.reasonStale,
    invalid_preview: i18n.reasonExpired,
    expired_preview: i18n.reasonExpired,
    confirmation_required: i18n.reasonExpired,
    invalid_confirmation: i18n.reasonExpired,
    confirmation_cancelled: i18n.reasonCancelled,
    invalid_frontmatter: i18n.reasonInvalidDocument,
    missing_frontmatter: i18n.reasonInvalidDocument,
    missing_name: i18n.reasonInvalidDocument,
    name_mismatch: i18n.reasonNameMismatch,
    import_not_found: i18n.reasonImportNotFound,
    unsupported_import: i18n.reasonUnsupportedImport,
    linked_path_rejected: i18n.reasonLinkedPath,
    destination_conflict: i18n.reasonConflict,
    restore_conflict: i18n.reasonConflict,
    recovery_not_found: i18n.reasonRecoveryNotFound,
    unsafe_download_url: i18n.reasonUnsafeDownload,
    private_network_rejected: i18n.reasonUnsafeDownload,
    unsupported_download_url: i18n.reasonUnsupportedDownload,
    download_file_limit: i18n.reasonDownloadLimit,
    download_size_limit: i18n.reasonDownloadLimit,
    download_timeout: i18n.reasonDownloadFailed,
    download_failed: i18n.reasonDownloadFailed,
    download_http_error: i18n.reasonDownloadFailed,
    invalid_skill_document: i18n.reasonDownloadFailed,
    missing_skill_document: i18n.reasonDownloadFailed,
    download_stage_failed: i18n.reasonDownloadFailed,
    invalid_github_commit: i18n.reasonDownloadFailed,
    unsupported_github_entry: i18n.reasonDownloadFailed,
    linked_download_entry: i18n.reasonDownloadFailed,
    download_path_escape: i18n.reasonDownloadFailed,
    invalid_download_response: i18n.reasonDownloadFailed,
    unexpected_download_host: i18n.reasonDownloadFailed,
    invalid_download_url: i18n.reasonDownloadFailed,
    download_dns_failed: i18n.reasonDownloadFailed,
    redirect_limit: i18n.reasonDownloadFailed,
    invalid_redirect: i18n.reasonDownloadFailed,
  }[reason];
  return descriptor ? intl.formatMessage(descriptor) : getSkillsLoadError(error, intl);
}

function skillPresentation(skill: ManagedSkill, intl: IntlShape) {
  const locale = intl.locale;
  const normalized = locale.toLowerCase();
  const candidates =
    normalized.startsWith('zh-tw') || normalized.startsWith('zh-hant')
      ? ['zh-TW', locale]
      : normalized.startsWith('zh')
        ? ['zh-CN', locale]
        : [locale, locale.split('-')[0]];
  const localized = candidates.map((key) => skill.displayMetadata?.locales?.[key]).find(Boolean);
  if (localized) return localized;
  return skill.source.rootKind === 'builtin'
    ? localizeKnownBuiltInSkill(skill, intl)
    : { name: skill.name, description: skill.description };
}

function scopeLabel(skill: ManagedSkill, intl: IntlShape) {
  if (skill.source.rootKind === 'global') return intl.formatMessage(i18n.global);
  if (skill.source.rootKind === 'plugin') return intl.formatMessage(i18n.plugin);
  if (skill.source.rootKind === 'builtin') return intl.formatMessage(i18n.builtin);
  return intl.formatMessage(i18n.project);
}

type EditorMode = 'create' | 'edit' | 'copy' | 'import' | 'download';
interface EditorState {
  mode: EditorMode;
  skill?: ManagedSkill;
  name: string;
  description: string;
  instructions: string;
  rawDocument: string;
  sourcePath: string;
  downloadUrl: string;
  destinationIndex: number;
}
const emptyEditor: EditorState = {
  mode: 'create',
  name: '',
  description: '',
  instructions: '',
  rawDocument: '',
  sourcePath: '',
  downloadUrl: '',
  destinationIndex: 0,
};

function operationFor(
  editor: EditorState,
  roots: SkillDestinationRoot[]
): SkillManagementOperation | null {
  if (editor.mode === 'edit' && editor.skill)
    return {
      operation: 'update_raw',
      source: editor.skill.source,
      expectedVersion: editor.skill.version,
      rawDocument: editor.rawDocument,
    };
  const root = roots[editor.destinationIndex];
  if (!root) return null;
  const destination = { rootKind: root.rootKind, rootId: root.rootId, name: editor.name };
  if (editor.mode === 'import')
    return { operation: 'import_local', destination, sourcePath: editor.sourcePath };
  if (editor.mode === 'copy' && editor.skill)
    return {
      operation: 'copy',
      source: editor.skill.source,
      expectedVersion: editor.skill.version,
      destination,
    };
  return {
    operation: 'create',
    destination,
    rawDocument: `---\nname: ${editor.name}\ndescription: ${editor.description}\n---\n${editor.instructions.trim()}\n`,
  };
}

export type SkillManagerRequest = { type: 'create' } | { type: 'detail'; skill: ManagedSkill };

interface SkillManagerProps {
  dialogOnly?: boolean;
  request?: SkillManagerRequest;
  onRequestClose?: () => void;
  onChanged?: () => void;
}

export default function SkillManager({
  dialogOnly = false,
  request,
  onRequestClose,
  onChanged,
}: SkillManagerProps = {}) {
  const intl = useIntl();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const projectDir = getInitialWorkingDir();
  const confirmations = useSyncExternalStore(
    subscribeSkillManagementConfirmations,
    getSkillManagementConfirmationsSnapshot
  );
  const confirmation = confirmations[0];
  const [skills, setSkills] = useState<ManagedSkill[]>([]);
  const [roots, setRoots] = useState<SkillDestinationRoot[]>([]);
  const [recoveries, setRecoveries] = useState<SkillRecoveryEntry[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [editor, setEditor] = useState<EditorState>();
  const [preview, setPreview] = useState<SkillManagementPreview>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [managed, deleted] = await Promise.all([
        listManagedSkills(projectDir),
        listSkillRecoveries(projectDir),
      ]);
      setSkills(managed.skills);
      setRoots(managed.destinationRoots);
      setRecoveries(deleted);
    } catch (cause) {
      setError(localizedError(cause, intl));
    } finally {
      setLoading(false);
    }
  }, [intl, projectDir]);

  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (loading || dialogOnly || searchParams.get('create') !== '1') return;
    setEditor({ ...emptyEditor });
    const next = new URLSearchParams(searchParams);
    next.delete('create');
    setSearchParams(next, { replace: true });
  }, [dialogOnly, loading, searchParams, setSearchParams]);
  useEffect(() => {
    if (loading || request?.type !== 'create') return;
    setEditor({ ...emptyEditor });
    onRequestClose?.();
  }, [loading, onRequestClose, request]);
  const filtered = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase(intl.locale);
    return skills.filter((skill) => {
      const visible = skillPresentation(skill, intl);
      return (
        !needle ||
        `${visible.name} ${visible.description}`.toLocaleLowerCase(intl.locale).includes(needle)
      );
    });
  }, [intl, search, skills]);
  const requestedSkill = searchParams.get('skill');
  const requestedSource = searchParams.get('source');
  const routeSelectedSkill = useMemo(() => {
    const candidates = skills.filter((skill) => skill.name === requestedSkill);
    if (!requestedSource || candidates.length < 2) return candidates[0];
    const normalizedSource = requestedSource.replace(/\\/g, '/').toLocaleLowerCase();
    return candidates.find((skill) => {
      const displayPath = skill.displayPath.replace(/\\/g, '/').toLocaleLowerCase();
      return displayPath === normalizedSource || normalizedSource.startsWith(`${displayPath}/`);
    });
  }, [requestedSkill, requestedSource, skills]);
  const selectedSkill =
    request?.type === 'detail' ? request.skill : dialogOnly ? undefined : routeSelectedSkill;

  function closeDetails() {
    if (request?.type === 'detail') {
      onRequestClose?.();
      return;
    }
    const next = new URLSearchParams(searchParams);
    next.delete('skill');
    next.delete('source');
    setSearchParams(next, { replace: true });
  }

  function openSkillConversation(skill: ManagedSkill) {
    const prefix = location.pathname.startsWith('/codepro') ? '/codepro' : '';
    navigate(`${prefix}/pair`, {
      state: {
        initialMessage: { msg: `/${skill.name} `, images: [] },
        noAutoSubmit: true,
        ...(skill.scope === 'project' ? { workingDir: projectDir } : {}),
      },
    });
  }

  async function prepare(operation: SkillManagementOperation) {
    setBusy(true);
    setError(undefined);
    try {
      const next = await previewSkillChange(operation, projectDir);
      if (next.hasConflict) throw new Error('destination_conflict');
      setPreview(next);
      setEditor(undefined);
    } catch (cause) {
      setError(localizedError(cause, intl));
    } finally {
      setBusy(false);
    }
  }

  async function prepareDownload(editor: EditorState) {
    const root = roots[editor.destinationIndex];
    if (!root) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await previewSkillDownload(
        editor.downloadUrl,
        { rootKind: root.rootKind, rootId: root.rootId, name: editor.name },
        projectDir
      );
      if (next.hasConflict) throw new Error('destination_conflict');
      setPreview(next);
      setEditor(undefined);
    } catch (cause) {
      setError(localizedError(cause, intl));
    } finally {
      setBusy(false);
    }
  }

  async function applyPreview() {
    if (!preview) return;
    setBusy(true);
    setError(undefined);
    try {
      await applySkillChange(preview.previewToken);
      setPreview(undefined);
      await load();
      onChanged?.();
    } catch (cause) {
      if (skillManagementErrorReason(cause) !== 'confirmation_cancelled')
        setError(localizedError(cause, intl));
    } finally {
      setBusy(false);
    }
  }

  const editorTitle =
    editor?.mode === 'edit'
      ? i18n.edit
      : editor?.mode === 'import'
        ? i18n.importLocal
        : editor?.mode === 'download'
          ? i18n.download
          : editor?.mode === 'copy'
            ? i18n.copy
            : i18n.create;

  return (
    <>
      {!dialogOnly && (
        <MainPanelLayout>
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="bg-background-primary px-8 pb-6 pt-16">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h1 className="text-4xl font-light">{intl.formatMessage(i18n.title)}</h1>
                  <p className="mt-1 text-sm text-text-secondary">
                    {intl.formatMessage(i18n.description, { shortcut: getSearchShortcutText() })}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() => setEditor({ ...emptyEditor, mode: 'download' })}
                  >
                    <Download className="mr-2 h-4 w-4" />
                    {intl.formatMessage(i18n.download)}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setEditor({ ...emptyEditor, mode: 'import' })}
                  >
                    <FolderInput className="mr-2 h-4 w-4" />
                    {intl.formatMessage(i18n.importLocal)}
                  </Button>
                  <Button onClick={() => setEditor({ ...emptyEditor })}>
                    <Plus className="mr-2 h-4 w-4" />
                    {intl.formatMessage(i18n.create)}
                  </Button>
                </div>
              </div>
            </div>
            <div className="min-h-0 flex-1 px-8">
              <SearchView onSearch={setSearch} placeholder={intl.formatMessage(i18n.search)}>
                {error && (
                  <div
                    role="alert"
                    className="mb-3 flex items-center gap-2 rounded-md bg-red-500/10 p-3 text-sm text-red-600"
                  >
                    <AlertCircle className="h-4 w-4" />
                    <span className="flex-1">{error}</span>
                    <Button size="sm" variant="outline" onClick={() => void load()}>
                      {intl.formatMessage(i18n.retry)}
                    </Button>
                  </div>
                )}
                {loading ? (
                  <p className="text-sm text-text-secondary">{intl.formatMessage(i18n.loading)}</p>
                ) : filtered.length === 0 ? (
                  <p className="text-sm text-text-secondary">
                    {intl.formatMessage(search ? i18n.noMatch : i18n.empty)}
                  </p>
                ) : (
                  <div className="space-y-2 pb-6">
                    {filtered.map((skill) => {
                      const visible = skillPresentation(skill, intl);
                      return (
                        <Card
                          key={`${skill.source.rootKind}:${skill.source.rootId}:${skill.source.relativePath}`}
                          role="button"
                          tabIndex={0}
                          aria-label={visible.name}
                          onClick={() => {
                            const next = new URLSearchParams(searchParams);
                            next.set('skill', skill.name);
                            next.set('source', skill.displayPath);
                            setSearchParams(next);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ')
                              event.currentTarget.click();
                          }}
                          className="cursor-pointer p-4 transition-colors hover:bg-background-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <div className="flex items-center justify-between gap-4">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <h3 className="truncate text-base">{visible.name}</h3>
                                <span className="rounded bg-background-secondary px-2 py-0.5 text-xs text-text-secondary">
                                  {scopeLabel(skill, intl)}
                                </span>
                                {skill.readOnly && (
                                  <span className="text-xs text-text-secondary">
                                    {intl.formatMessage(i18n.readOnly)}
                                  </span>
                                )}
                                <span className="rounded bg-background-secondary px-2 py-0.5 text-xs text-text-secondary">
                                  {intl.formatMessage(skill.enabled ? i18n.enabled : i18n.disabled)}
                                </span>
                              </div>
                              <p className="mt-1 line-clamp-2 text-sm text-text-secondary">
                                {visible.description}
                              </p>
                              <p className="mt-1 truncate text-xs text-text-muted">
                                {skill.displayPath}
                              </p>
                            </div>
                            <div className="flex shrink-0 gap-1">
                              {!skill.readOnly && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  aria-label={intl.formatMessage(
                                    skill.enabled ? i18n.disable : i18n.enable
                                  )}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void prepare({
                                      operation: 'set_enabled',
                                      source: skill.source,
                                      expectedVersion: skill.version,
                                      enabled: !skill.enabled,
                                    });
                                  }}
                                >
                                  <Power className="h-4 w-4" />
                                </Button>
                              )}
                              {!skill.readOnly && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  aria-label={intl.formatMessage(i18n.edit)}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setEditor({
                                      ...emptyEditor,
                                      mode: 'edit',
                                      skill,
                                      name: skill.name,
                                      rawDocument: skill.rawDocument,
                                    });
                                  }}
                                >
                                  <FilePenLine className="h-4 w-4" />
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-label={intl.formatMessage(i18n.copy)}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setEditor({
                                    ...emptyEditor,
                                    mode: 'copy',
                                    skill,
                                    name: `${skill.name}-copy`,
                                  });
                                }}
                              >
                                <Copy className="h-4 w-4" />
                              </Button>
                              {!skill.readOnly && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  aria-label={intl.formatMessage(i18n.delete)}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void prepare({
                                      operation: 'delete',
                                      source: skill.source,
                                      expectedVersion: skill.version,
                                    });
                                  }}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              )}
                            </div>
                          </div>
                        </Card>
                      );
                    })}
                  </div>
                )}
                {recoveries.length > 0 && (
                  <div className="border-t border-border-primary py-4">
                    <h2 className="mb-2 text-sm font-medium">
                      {intl.formatMessage(i18n.recovered)}
                    </h2>
                    {recoveries.map((item) => (
                      <div
                        key={item.recoveryRef}
                        className="flex items-center justify-between py-1 text-sm"
                      >
                        <span>{item.name}</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            void prepare({ operation: 'restore', recoveryRef: item.recoveryRef })
                          }
                        >
                          <RotateCcw className="mr-2 h-4 w-4" />
                          {intl.formatMessage(i18n.restore)}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </SearchView>
            </div>
          </div>
        </MainPanelLayout>
      )}

      <Dialog open={!!selectedSkill} onOpenChange={(open) => !open && closeDetails()}>
        <DialogContent className="flex max-h-[85dvh] w-[calc(100%-2rem)] min-w-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
          {selectedSkill && (
            <>
              <DialogHeader className="m-0 shrink-0 px-6 pt-6 pb-4 pr-14 text-left">
                <DialogTitle className="min-w-0 leading-6 [overflow-wrap:anywhere]">
                  {skillPresentation(selectedSkill, intl).name}
                </DialogTitle>
              </DialogHeader>
              <div className="min-h-0 min-w-0 space-y-5 overflow-y-auto px-6 pb-6 [overflow-wrap:anywhere]">
                <DialogDescription className="whitespace-pre-wrap leading-6">
                  {skillPresentation(selectedSkill, intl).description}
                </DialogDescription>
                <div>
                  <p className="text-xs font-medium text-text-muted">
                    {intl.formatMessage(i18n.source)}
                  </p>
                  <p className="break-all text-sm">{selectedSkill.displayPath}</p>
                </div>
                <div>
                  <p className="text-xs font-medium text-text-muted">
                    {intl.formatMessage(i18n.content)}
                  </p>
                  <pre className="mt-2 min-w-0 whitespace-pre-wrap rounded-lg bg-background-secondary p-4 text-sm leading-6 [overflow-wrap:anywhere]">
                    {selectedSkill.rawDocument}
                  </pre>
                </div>
              </div>
              <DialogFooter className="shrink-0 flex-row flex-wrap border-t px-6 py-4">
                <Button variant="outline" onClick={closeDetails}>
                  {intl.formatMessage(i18n.close)}
                </Button>
                {!selectedSkill.readOnly && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      closeDetails();
                      void prepare({
                        operation: 'set_enabled',
                        source: selectedSkill.source,
                        expectedVersion: selectedSkill.version,
                        enabled: !selectedSkill.enabled,
                      });
                    }}
                  >
                    {intl.formatMessage(selectedSkill.enabled ? i18n.disable : i18n.enable)}
                  </Button>
                )}
                {!selectedSkill.readOnly && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      closeDetails();
                      setEditor({
                        ...emptyEditor,
                        mode: 'edit',
                        skill: selectedSkill,
                        name: selectedSkill.name,
                        rawDocument: selectedSkill.rawDocument,
                      });
                    }}
                  >
                    {intl.formatMessage(i18n.edit)}
                  </Button>
                )}
                <Button
                  variant="outline"
                  onClick={() => {
                    closeDetails();
                    setEditor({
                      ...emptyEditor,
                      mode: 'copy',
                      skill: selectedSkill,
                      name: `${selectedSkill.name}-copy`,
                      rawDocument: selectedSkill.rawDocument,
                    });
                  }}
                >
                  {intl.formatMessage(i18n.copy)}
                </Button>
                {!selectedSkill.readOnly && (
                  <Button
                    variant="destructive"
                    onClick={() => {
                      closeDetails();
                      void prepare({
                        operation: 'delete',
                        source: selectedSkill.source,
                        expectedVersion: selectedSkill.version,
                      });
                    }}
                  >
                    {intl.formatMessage(i18n.delete)}
                  </Button>
                )}
                <Button
                  disabled={!selectedSkill.enabled}
                  onClick={() => openSkillConversation(selectedSkill)}
                >
                  {intl.formatMessage(i18n.use)}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!editor} onOpenChange={(open) => !open && setEditor(undefined)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{intl.formatMessage(editorTitle)}</DialogTitle>
            <DialogDescription>{intl.formatMessage(i18n.nameHelp)}</DialogDescription>
          </DialogHeader>
          {editor && (
            <div className="space-y-4">
              {editor.mode !== 'edit' && (
                <>
                  <label className="block text-sm">
                    {intl.formatMessage(i18n.name)}
                    <Input
                      className="mt-1"
                      value={editor.name}
                      onChange={(event) => setEditor({ ...editor, name: event.target.value })}
                    />
                  </label>
                  <label className="block text-sm">
                    {intl.formatMessage(i18n.destination)}
                    <select
                      className="mt-1 h-9 w-full rounded-md border border-border-primary bg-background-primary px-3 text-sm"
                      value={editor.destinationIndex}
                      onChange={(event) =>
                        setEditor({ ...editor, destinationIndex: Number(event.target.value) })
                      }
                    >
                      {roots.map((root, index) => (
                        <option key={`${root.rootKind}:${root.rootId}`} value={index}>
                          {root.displayPath}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              {editor.mode === 'create' && (
                <>
                  <label className="block text-sm">
                    {intl.formatMessage(i18n.descriptionLabel)}
                    <Input
                      className="mt-1"
                      value={editor.description}
                      onChange={(event) =>
                        setEditor({ ...editor, description: event.target.value })
                      }
                    />
                  </label>
                  <label className="block text-sm">
                    {intl.formatMessage(i18n.instructions)}
                    <textarea
                      className="mt-1 min-h-40 w-full rounded-md border border-border-primary bg-background-primary p-3 text-sm"
                      value={editor.instructions}
                      onChange={(event) =>
                        setEditor({ ...editor, instructions: event.target.value })
                      }
                    />
                  </label>
                </>
              )}
              {editor.mode === 'edit' && (
                <label className="block text-sm">
                  {intl.formatMessage(i18n.document)}
                  <textarea
                    className="mt-1 min-h-80 w-full rounded-md border border-border-primary bg-background-primary p-3 font-mono text-sm"
                    value={editor.rawDocument}
                    onChange={(event) => setEditor({ ...editor, rawDocument: event.target.value })}
                  />
                </label>
              )}
              {editor.mode === 'import' && (
                <label className="block text-sm">
                  {intl.formatMessage(i18n.sourcePath)}
                  <div className="mt-1 flex gap-2">
                    <Input
                      value={editor.sourcePath}
                      onChange={(event) => setEditor({ ...editor, sourcePath: event.target.value })}
                    />
                    <Button
                      variant="outline"
                      onClick={async () => {
                        const selected = await window.electron.selectFileOrDirectory(
                          editor.sourcePath || undefined
                        );
                        if (selected) setEditor({ ...editor, sourcePath: selected });
                      }}
                    >
                      {intl.formatMessage(i18n.browse)}
                    </Button>
                  </div>
                </label>
              )}
              {editor.mode === 'download' && (
                <label className="block text-sm">
                  {intl.formatMessage(i18n.downloadUrl)}
                  <Input
                    className="mt-1"
                    value={editor.downloadUrl}
                    onChange={(event) => setEditor({ ...editor, downloadUrl: event.target.value })}
                  />
                </label>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditor(undefined)}>
              {intl.formatMessage(i18n.cancel)}
            </Button>
            <Button
              disabled={
                busy ||
                !editor?.name ||
                (editor.mode === 'import' && !editor.sourcePath) ||
                (editor.mode === 'download' && !editor.downloadUrl)
              }
              onClick={() => {
                if (!editor) return;
                if (editor.mode === 'download') {
                  void prepareDownload(editor);
                  return;
                }
                const operation = operationFor(editor, roots);
                if (operation) void prepare(operation);
              }}
            >
              {intl.formatMessage(i18n.continue)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!preview} onOpenChange={(open) => !open && !busy && setPreview(undefined)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{intl.formatMessage(i18n.previewTitle)}</DialogTitle>
            <DialogDescription>
              {preview && intl.formatMessage(i18n.previewTarget, { target: preview.target })}
            </DialogDescription>
          </DialogHeader>
          {preview?.files.length ? (
            <p className="text-sm text-text-secondary">
              {intl.formatMessage(i18n.previewFiles, { files: preview.files.join(', ') })}
            </p>
          ) : null}
          {preview?.diff && (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-background-secondary p-3 text-xs">
              {preview.diff}
            </pre>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setPreview(undefined)}>
              {intl.formatMessage(i18n.cancel)}
            </Button>
            <Button disabled={busy} onClick={() => void applyPreview()}>
              {intl.formatMessage(i18n.save)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmationModal
        isOpen={!!confirmation}
        title={intl.formatMessage(i18n.deleteTitle)}
        message={intl.formatMessage(i18n.deleteMessage, { target: confirmation?.target ?? '' })}
        detail={confirmation?.target}
        confirmLabel={intl.formatMessage(i18n.confirmDelete)}
        cancelLabel={intl.formatMessage(i18n.cancel)}
        confirmVariant="destructive"
        onConfirm={() =>
          confirmation && resolveSkillManagementConfirmation(confirmation.previewToken, 'confirm')
        }
        onCancel={() =>
          confirmation && resolveSkillManagementConfirmation(confirmation.previewToken, 'cancel')
        }
      />
    </>
  );
}
