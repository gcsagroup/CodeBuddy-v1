import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, FolderCheck, FolderPlus, GitBranch } from 'lucide-react';
import type { CodeProWorkspaceInspection } from '../../codepro/projectWorkspace';
import { useIntl } from '../../i18n';
import { Button } from '../ui/button';
import {
  workspaceConfirmationMessages as messages,
  workspaceStateMessages,
} from './workspaceConfirmationMessages';

interface WorkspaceConfirmationCardProps {
  candidates: CodeProWorkspaceInspection[];
  confirming: boolean;
  error: string | null;
  onConfirm: (candidate: CodeProWorkspaceInspection) => void;
  onCreateSeparateProject?: (candidate: CodeProWorkspaceInspection) => void;
  onCancel: () => void;
}

function canConfirm(candidate: CodeProWorkspaceInspection | undefined): boolean {
  return candidate !== undefined && candidate.state !== 'file' && candidate.state !== 'unavailable';
}

export function WorkspaceConfirmationCard({
  candidates,
  confirming,
  error,
  onConfirm,
  onCreateSeparateProject,
  onCancel,
}: WorkspaceConfirmationCardProps) {
  const intl = useIntl();
  const [selectedIdentity, setSelectedIdentity] = useState<string | null>(
    candidates.length === 1 ? candidates[0].normalizedIdentity : null
  );
  const confirmRef = useRef<HTMLButtonElement>(null);
  const scopeChoiceRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setSelectedIdentity(candidates.length === 1 ? candidates[0].normalizedIdentity : null);
  }, [candidates]);

  const selected = useMemo(
    () => candidates.find((candidate) => candidate.normalizedIdentity === selectedIdentity),
    [candidates, selectedIdentity]
  );
  const requiresScopeChoice =
    selected?.state === 'non-empty-directory' && onCreateSeparateProject !== undefined;

  useEffect(() => {
    if (candidates.length !== 1) return;
    if (requiresScopeChoice) {
      scopeChoiceRef.current?.focus();
    } else {
      confirmRef.current?.focus();
    }
  }, [candidates.length, requiresScopeChoice]);

  return (
    <section
      ref={scopeChoiceRef}
      tabIndex={-1}
      className="rounded-lg border border-border-primary bg-background-default p-4 shadow-sm"
      aria-labelledby="workspace-confirmation-title"
      aria-busy={confirming}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 rounded-md bg-background-secondary p-2 text-text-secondary">
          <FolderCheck className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2
            id="workspace-confirmation-title"
            className="text-base font-semibold text-text-primary"
          >
            {intl.formatMessage(
              requiresScopeChoice ? messages.existingProjectTitle : messages.title
            )}
          </h2>
          <p className="mt-1 text-sm text-text-secondary">
            {intl.formatMessage(
              selected?.state === 'filesystem-root'
                ? messages.rootDescription
                : requiresScopeChoice
                  ? messages.existingProjectDescription
                  : messages.description
            )}
          </p>
        </div>
      </div>

      {requiresScopeChoice && (
        <p className="mt-3 rounded-md bg-background-secondary p-3 text-sm text-text-secondary">
          {intl.formatMessage(messages.sharedProjectEffects)}
        </p>
      )}

      <div
        className="mt-4 space-y-2"
        role={candidates.length > 1 ? 'radiogroup' : undefined}
        aria-label={candidates.length > 1 ? intl.formatMessage(messages.candidateGroup) : undefined}
      >
        {candidates.map((candidate) => {
          const checked = candidate.normalizedIdentity === selectedIdentity;
          const content = (
            <>
              <span className="block break-all font-mono text-sm text-text-primary">
                {candidate.normalizedPath}
              </span>
              <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
                <span className="inline-flex items-center gap-1">
                  {candidate.state === 'missing' ? (
                    <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : candidate.state === 'filesystem-root' ||
                    candidate.state === 'file' ||
                    candidate.state === 'unavailable' ? (
                    <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <FolderCheck className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {intl.formatMessage(workspaceStateMessages[candidate.state])}
                </span>
                {candidate.isGitRepository && (
                  <span className="inline-flex items-center gap-1">
                    <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
                    {intl.formatMessage(messages.gitRepository)}
                  </span>
                )}
              </span>
              <ul
                className="mt-2 space-y-1 text-xs text-text-secondary"
                aria-label={intl.formatMessage(messages.executionBoundary)}
              >
                <li>{intl.formatMessage(messages.localDirectory)}</li>
                <li>
                  {intl.formatMessage(messages.writableRootLabel)}:{' '}
                  {candidate.state === 'filesystem-root'
                    ? intl.formatMessage(messages.noWritableRoot)
                    : candidate.normalizedPath}
                </li>
                {candidate.canonicalPath &&
                  candidate.canonicalPath !== candidate.normalizedPath && (
                    <li>
                      {intl.formatMessage(messages.resolvedPathLabel)}: {candidate.canonicalPath}
                    </li>
                  )}
                <li>{intl.formatMessage(messages.worktreeOff)}</li>
              </ul>
            </>
          );

          if (candidates.length === 1) {
            return (
              <div
                key={candidate.normalizedIdentity}
                className="rounded-md border border-border-primary bg-background-secondary p-3"
              >
                {content}
              </div>
            );
          }

          return (
            <label
              key={candidate.normalizedIdentity}
              className="flex cursor-pointer items-start gap-3 rounded-md border border-border-primary p-3 has-[:checked]:bg-background-secondary"
            >
              <input
                type="radio"
                name="codepro-workspace"
                value={candidate.normalizedIdentity}
                checked={checked}
                onChange={() => setSelectedIdentity(candidate.normalizedIdentity)}
                className="mt-1"
              />
              <span className="min-w-0 flex-1">{content}</span>
            </label>
          );
        })}
      </div>

      {error && (
        <p className="mt-3 text-sm text-text-primary" role="alert">
          {error}
        </p>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={confirming} onClick={onCancel}>
          {intl.formatMessage(messages.cancel)}
        </Button>
        {requiresScopeChoice ? (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={confirming || !canConfirm(selected)}
              onClick={() => selected && onConfirm(selected)}
            >
              {intl.formatMessage(messages.continueExistingProject)}
            </Button>
            <Button
              type="button"
              disabled={confirming || !selected}
              onClick={() => selected && onCreateSeparateProject?.(selected)}
            >
              {confirming
                ? intl.formatMessage(messages.starting)
                : intl.formatMessage(messages.createSeparateProject)}
            </Button>
          </>
        ) : (
          <Button
            ref={confirmRef}
            type="button"
            disabled={confirming || !canConfirm(selected)}
            onClick={() => selected && onConfirm(selected)}
          >
            {confirming
              ? intl.formatMessage(messages.starting)
              : selected?.state === 'filesystem-root'
                ? intl.formatMessage(messages.confirmContainer)
                : intl.formatMessage(messages.confirm)}
          </Button>
        )}
      </div>
    </section>
  );
}
