import type { DraftRequest, NewTaskDraft, NewTaskDraftKey } from '../drafts/types';
export type { NewTaskDraftKey } from '../drafts/types';
const drafts = new Map<NewTaskDraftKey, NewTaskDraft>();
let storageError = false;
let restoreFailed = false;
const failedFields = new Set<string>();
const versions = new Map<string, number>();
const listeners = new Set<() => void>();
export const subscribeDraftStorage = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const hasDraftStorageError = () => storageError;
function reportError(failed: boolean) {
  storageError = failed;
  listeners.forEach((listener) => listener());
}

export async function initializeNewTaskDrafts() {
  if (!window.electron?.newTaskDraft) return;
  try {
    const snapshot = await window.electron.newTaskDraft({ action: 'read' });
    drafts.clear();
    for (const key of ['code', 'codepro'] as const) {
      if (snapshot[key]) drafts.set(key, snapshot[key]);
    }
    restoreFailed = false;
    failedFields.clear();
    reportError(false);
  } catch {
    restoreFailed = true;
    reportError(true);
  }
}

function persist(request: DraftRequest) {
  if (restoreFailed || !window.electron?.newTaskDraft) return;
  const fields =
    request.action === 'update'
      ? Object.keys(request.patch).map((field) => `${request.key}:${field}`)
      : request.action === 'clear'
        ? ['text', 'workingDir', 'images', 'files', 'permissionPreset'].map((field) => `${request.key}:${field}`)
        : [];
  const revisions = fields.map((field) => {
    const version = (versions.get(field) ?? 0) + 1;
    versions.set(field, version);
    return [field, version] as const;
  });
  void window.electron.newTaskDraft(request).then(
    (snapshot) => {
      revisions.forEach(([field, version]) => {
        if (versions.get(field) === version) failedFields.delete(field);
      });
      if (
        request.action === 'update' &&
        snapshot[request.key]?.files &&
        revisions.some(
          ([field, version]) => field === `${request.key}:files` && versions.get(field) === version
        )
      ) {
        drafts.set(request.key, {
          ...readNewTaskDraft(request.key),
          files: snapshot[request.key]!.files,
        });
      }
      reportError(failedFields.size > 0);
    },
    () => {
      revisions.forEach(([field, version]) => {
        if (versions.get(field) === version) failedFields.add(field);
      });
      reportError(failedFields.size > 0);
    }
  );
}

export const readNewTaskDraft = (key: NewTaskDraftKey): NewTaskDraft => drafts.get(key) ?? {};
export function updateNewTaskDraft(key: NewTaskDraftKey, update: NewTaskDraft) {
  const previous = readNewTaskDraft(key);
  if (
    Object.entries(update).every(
      ([field, value]) => previous[field as keyof NewTaskDraft] === value
    )
  )
    return;
  drafts.set(key, { ...readNewTaskDraft(key), ...update });
  persist({ action: 'update', key, patch: update });
}
export function clearNewTaskDraft(key: NewTaskDraftKey) {
  drafts.delete(key);
  persist({ action: 'clear', key });
}
