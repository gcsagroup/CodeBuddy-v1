import type { GitHubCiRun } from '@aaif/goose-sdk';
import { useEffect, useRef, useState } from 'react';
import {
  acpCancelGitHubCiRun,
  acpGetGitHubCiArtifacts,
  acpGetGitHubCiStatus,
  acpPreviewGitHubCiCancel,
  acpPreviewGitHubCiRerun,
  acpRerunFailedGitHubCiJobs,
  type GitHubCiRerunPreviewResponse,
  type GitHubCiCancelPreviewResponse,
  type GitHubCiStatusRequest,
  type GitHubCiStatusResponse,
} from '../../acp/githubCi';
import { defineMessages, useIntl } from '../../i18n';
import { eligibleForRerun, safeError, validRerunPreview, validRerunReceipt } from './githubCiRerun';
import { eligibleForCancel, validCancelPreview, validCancelReceipt } from './githubCiCancel';

const i18n = defineMessages({
  previewFailed: {
    id: 'githubCi.rerun.previewFailed',
    defaultMessage: 'CodePro could not verify this workflow run.',
  },
  failed: {
    id: 'githubCi.rerun.failed',
    defaultMessage: 'GitHub did not accept the rerun request.',
  },
  invalidResponse: {
    id: 'githubCi.rerun.invalidResponse',
    defaultMessage: 'GitHub returned an unexpected rerun receipt.',
  },
  cancelPreviewFailed: {
    id: 'githubCi.cancel.previewFailed',
    defaultMessage: 'CodePro could not verify this workflow run for cancellation.',
  },
  cancelFailed: {
    id: 'githubCi.cancel.failed',
    defaultMessage: 'GitHub did not accept the cancellation request.',
  },
  cancelInvalidResponse: {
    id: 'githubCi.cancel.invalidResponse',
    defaultMessage: 'GitHub returned an unexpected cancellation receipt.',
  },
});

export interface GitHubCiStatusPanelApi {
  load: (request: GitHubCiStatusRequest) => Promise<GitHubCiStatusResponse>;
  artifacts?: typeof acpGetGitHubCiArtifacts;
  preview: typeof acpPreviewGitHubCiRerun;
  rerun: typeof acpRerunFailedGitHubCiJobs;
  cancelPreview: typeof acpPreviewGitHubCiCancel;
  cancel: typeof acpCancelGitHubCiRun;
}

export const defaultGitHubCiStatusPanelApi: GitHubCiStatusPanelApi = {
  load: acpGetGitHubCiStatus,
  artifacts: acpGetGitHubCiArtifacts,
  preview: acpPreviewGitHubCiRerun,
  rerun: acpRerunFailedGitHubCiJobs,
  cancelPreview: acpPreviewGitHubCiCancel,
  cancel: acpCancelGitHubCiRun,
};

export function useGitHubCiStatus(
  workingDirectory: string | undefined,
  api: GitHubCiStatusPanelApi
) {
  const intl = useIntl();
  const [status, setStatus] = useState<GitHubCiStatusResponse>();
  const [error, setError] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [rerunPreview, setRerunPreview] = useState<GitHubCiRerunPreviewResponse>();
  const [previewingRunId, setPreviewingRunId] = useState<number>();
  const [isRerunning, setIsRerunning] = useState(false);
  const [rerunError, setRerunError] = useState<string>();
  const [rerunAccepted, setRerunAccepted] = useState(false);
  const [cancelPreview, setCancelPreview] = useState<GitHubCiCancelPreviewResponse>();
  const [previewingCancelRunId, setPreviewingCancelRunId] = useState<number>();
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string>();
  const [cancelAccepted, setCancelAccepted] = useState(false);
  const operationVersion = useRef(0);
  const busy = useRef(false);

  const loadStatus = async () => {
    if (!workingDirectory || busy.current) return;
    const version = ++operationVersion.current;
    busy.current = true;
    setIsLoading(true);
    setError(false);
    try {
      const result = await api.load({ workingDir: workingDirectory });
      if (operationVersion.current === version) setStatus(result);
    } catch {
      if (operationVersion.current === version) {
        setStatus(undefined);
        setError(true);
      }
    } finally {
      if (operationVersion.current === version) {
        busy.current = false;
        setIsLoading(false);
      }
    }
  };

  useEffect(() => {
    operationVersion.current += 1;
    busy.current = false;
    setStatus(undefined);
    setError(false);
    setIsLoading(false);
    setRerunPreview(undefined);
    setPreviewingRunId(undefined);
    setIsRerunning(false);
    setRerunError(undefined);
    setRerunAccepted(false);
    setCancelPreview(undefined);
    setPreviewingCancelRunId(undefined);
    setIsCancelling(false);
    setCancelError(undefined);
    setCancelAccepted(false);
    void loadStatus();
    return () => {
      operationVersion.current += 1;
      busy.current = false;
    };
    // Loading is intentionally tied only to the selected project and injected API.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workingDirectory, api]);

  const previewRerun = async (run: GitHubCiRun) => {
    if (!workingDirectory || !status || !eligibleForRerun(run) || busy.current) return;
    const version = ++operationVersion.current;
    busy.current = true;
    setPreviewingRunId(run.id);
    setRerunError(undefined);
    setRerunAccepted(false);
    setCancelError(undefined);
    setCancelAccepted(false);
    try {
      const result = await api.preview({ workingDir: workingDirectory, runId: run.id });
      if (operationVersion.current !== version) return;
      if (!validRerunPreview(status, run, result)) {
        setRerunError(intl.formatMessage(i18n.invalidResponse));
        return;
      }
      setRerunPreview(result);
    } catch (cause) {
      if (operationVersion.current === version) {
        setRerunError(safeError(cause, intl.formatMessage(i18n.previewFailed)));
      }
    } finally {
      if (operationVersion.current === version) {
        busy.current = false;
        setPreviewingRunId(undefined);
      }
    }
  };

  const rerunFailedJobs = async () => {
    if (!workingDirectory || !rerunPreview || busy.current) return;
    const preview = rerunPreview;
    const version = ++operationVersion.current;
    busy.current = true;
    setIsRerunning(true);
    setRerunError(undefined);
    setRerunAccepted(false);
    try {
      const receipt = await api.rerun({
        workingDir: workingDirectory,
        runId: preview.run.id,
        preflightId: preview.preflightId,
      });
      if (operationVersion.current !== version) return;
      setRerunPreview(undefined);
      if (!validRerunReceipt(preview, receipt)) {
        setRerunError(intl.formatMessage(i18n.invalidResponse));
        return;
      }
      setRerunAccepted(true);
      try {
        const refreshed = await api.load({ workingDir: workingDirectory });
        if (operationVersion.current === version) setStatus(refreshed);
      } catch {
        if (operationVersion.current === version) setError(true);
      }
    } catch (cause) {
      if (operationVersion.current === version) {
        setRerunPreview(undefined);
        setRerunError(safeError(cause, intl.formatMessage(i18n.failed)));
      }
    } finally {
      if (operationVersion.current === version) {
        busy.current = false;
        setIsRerunning(false);
      }
    }
  };

  const previewCancel = async (run: GitHubCiRun) => {
    if (!workingDirectory || !status || !eligibleForCancel(run) || busy.current) return;
    const version = ++operationVersion.current;
    busy.current = true;
    setPreviewingCancelRunId(run.id);
    setCancelError(undefined);
    setCancelAccepted(false);
    setRerunError(undefined);
    setRerunAccepted(false);
    try {
      const result = await api.cancelPreview({ workingDir: workingDirectory, runId: run.id });
      if (operationVersion.current !== version) return;
      if (!validCancelPreview(status, run, result)) {
        setCancelError(intl.formatMessage(i18n.cancelInvalidResponse));
        return;
      }
      setCancelPreview(result);
    } catch (cause) {
      if (operationVersion.current === version) {
        setCancelError(safeError(cause, intl.formatMessage(i18n.cancelPreviewFailed)));
      }
    } finally {
      if (operationVersion.current === version) {
        busy.current = false;
        setPreviewingCancelRunId(undefined);
      }
    }
  };

  const cancelRun = async () => {
    if (!workingDirectory || !cancelPreview || busy.current) return;
    const preview = cancelPreview;
    const version = ++operationVersion.current;
    busy.current = true;
    setIsCancelling(true);
    setCancelError(undefined);
    setCancelAccepted(false);
    try {
      const receipt = await api.cancel({
        workingDir: workingDirectory,
        runId: preview.run.id,
        preflightId: preview.preflightId,
      });
      if (operationVersion.current !== version) return;
      setCancelPreview(undefined);
      if (!validCancelReceipt(preview, receipt)) {
        setCancelError(intl.formatMessage(i18n.cancelInvalidResponse));
        return;
      }
      setCancelAccepted(true);
      try {
        const refreshed = await api.load({ workingDir: workingDirectory });
        if (operationVersion.current === version) setStatus(refreshed);
      } catch {
        if (operationVersion.current === version) setError(true);
      }
    } catch (cause) {
      if (operationVersion.current === version) {
        setCancelPreview(undefined);
        setCancelError(safeError(cause, intl.formatMessage(i18n.cancelFailed)));
      }
    } finally {
      if (operationVersion.current === version) {
        busy.current = false;
        setIsCancelling(false);
      }
    }
  };

  return {
    status,
    error,
    isLoading,
    rerunPreview,
    previewingRunId,
    isRerunning,
    rerunError,
    rerunAccepted,
    cancelPreview,
    previewingCancelRunId,
    isCancelling,
    cancelError,
    cancelAccepted,
    interactionBusy:
      isLoading ||
      previewingRunId !== undefined ||
      isRerunning ||
      previewingCancelRunId !== undefined ||
      isCancelling,
    loadStatus,
    previewRerun,
    rerunFailedJobs,
    cancelRerun: () => setRerunPreview(undefined),
    previewCancel,
    cancelRun,
    closeCancel: () => setCancelPreview(undefined),
  };
}
