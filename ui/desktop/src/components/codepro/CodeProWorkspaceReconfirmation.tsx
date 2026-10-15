import { useEffect, useState } from 'react';
import type { CodeProWorkspaceInspection } from '../../codepro/projectWorkspace';
import { normalizeWorkspaceIdentity } from '../../codepro/workspaceIdentity';
import type { CodeProWorkspaceReconfirmationRequest } from '../../codepro/resumeCodeProSession';
import { defineMessages, useIntl } from '../../i18n';
import { Button } from '../ui/button';
import { WorkspaceConfirmationCard } from './WorkspaceConfirmationCard';
import { workspaceConfirmationMessages as messages } from './workspaceConfirmationMessages';

interface CodeProWorkspaceReconfirmationProps {
  request: CodeProWorkspaceReconfirmationRequest;
  confirming: boolean;
  error: string | null;
  onConfirm: (candidate: CodeProWorkspaceInspection) => void;
  onCancel: () => void;
  inspectWorkspace?: (input: {
    prompt: string;
    selectedWorkingDir: string;
  }) => Promise<CodeProWorkspaceInspection[]>;
}

const inspectCodeProWorkspace = (input: { prompt: string; selectedWorkingDir: string }) =>
  window.electron.inspectCodeProWorkspace(input);

const recoveryMessages = defineMessages({
  retry: { id: 'appsView.retry', defaultMessage: 'Retry' },
});

function isExactExistingCandidate(
  workingDir: string,
  candidate: CodeProWorkspaceInspection
): boolean {
  return (
    (candidate.state === 'empty-directory' || candidate.state === 'non-empty-directory') &&
    candidate.normalizedIdentity === normalizeWorkspaceIdentity(workingDir)
  );
}

export function CodeProWorkspaceReconfirmation({
  request,
  confirming,
  error,
  onConfirm,
  onCancel,
  inspectWorkspace = inspectCodeProWorkspace,
}: CodeProWorkspaceReconfirmationProps) {
  const intl = useIntl();
  const [candidate, setCandidate] = useState<CodeProWorkspaceInspection>();
  const [inspectionError, setInspectionError] = useState<'mismatch' | 'unavailable'>();
  const [inspecting, setInspecting] = useState(true);
  const [inspectionAttempt, setInspectionAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setCandidate(undefined);
    setInspectionError(undefined);
    setInspecting(true);

    inspectWorkspace({
      prompt: `Resume the existing project at "${request.workingDir}"`,
      selectedWorkingDir: request.workingDir,
    })
      .then((candidates) => {
        if (!active) return;
        const exact = candidates.find((entry) =>
          isExactExistingCandidate(request.workingDir, entry)
        );
        if (!exact) {
          setInspectionError('mismatch');
          return;
        }
        setCandidate(exact);
      })
      .catch(() => {
        if (!active) return;
        setInspectionError('unavailable');
      })
      .finally(() => {
        if (active) setInspecting(false);
      });

    return () => {
      active = false;
    };
  }, [inspectWorkspace, request.sessionId, request.workingDir, inspectionAttempt]);

  if (inspecting) {
    return <p role="status">{intl.formatMessage(messages.checkingPersistedWorkspace)}</p>;
  }

  if (inspectionError || !candidate) {
    return (
      <section className="space-y-3">
        <p role="alert" className="text-sm text-text-primary">
          {intl.formatMessage(
            inspectionError === 'mismatch'
              ? messages.persistedWorkspaceMismatch
              : messages.persistedWorkspaceUnavailable
          )}
        </p>
        <Button type="button" onClick={() => setInspectionAttempt((attempt) => attempt + 1)}>
          {intl.formatMessage(recoveryMessages.retry)}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {intl.formatMessage(messages.cancel)}
        </Button>
      </section>
    );
  }

  return (
    <WorkspaceConfirmationCard
      candidates={[candidate]}
      confirming={confirming}
      error={error}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
