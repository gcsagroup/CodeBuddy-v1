import type { GitHubWorkflowDispatchWorkflow } from '@aaif/goose-sdk';
import { AlertTriangle, LoaderCircle, Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  acpDispatchGitHubWorkflow,
  acpGetGitHubWorkflowDispatchCatalog,
  acpPreviewGitHubWorkflowDispatch,
  type GitHubWorkflowDispatchCatalogRequest,
  type GitHubWorkflowDispatchCatalogResponse,
  type GitHubWorkflowDispatchPreviewResponse,
  type GitHubWorkflowDispatchRequest,
  type GitHubWorkflowDispatchResponse,
} from '../../acp/githubCi';
import { defineMessages, useIntl } from '../../i18n';
import { ConfirmationModal } from '../ui/ConfirmationModal';
import {
  dispatchInputValues,
  dispatchRequiredInputsPresent,
  githubDispatchErrorCode,
  validWorkflowDispatchPreview,
  validWorkflowDispatchReceipt,
  type GitHubWorkflowDispatchFormValues,
} from './githubWorkflowDispatch';

const i18n = defineMessages({
  title: { id: 'githubCi.dispatch.title', defaultMessage: 'Run a workflow' },
  description: {
    id: 'githubCi.dispatch.description',
    defaultMessage: 'Trigger an active workflow on the exact pushed default-branch commit.',
  },
  workflow: { id: 'githubCi.dispatch.workflow', defaultMessage: 'Workflow' },
  selectValue: { id: 'githubCi.dispatch.selectValue', defaultMessage: 'Select a value' },
  trueValue: { id: 'githubCi.dispatch.trueValue', defaultMessage: 'True' },
  falseValue: { id: 'githubCi.dispatch.falseValue', defaultMessage: 'False' },
  optional: { id: 'githubCi.dispatch.optional', defaultMessage: 'Optional' },
  required: { id: 'githubCi.dispatch.required', defaultMessage: 'Required' },
  review: { id: 'githubCi.dispatch.review', defaultMessage: 'Review workflow run' },
  loading: { id: 'githubCi.dispatch.loading', defaultMessage: 'Loading workflows…' },
  noWorkflows: {
    id: 'githubCi.dispatch.noWorkflows',
    defaultMessage: 'No active workflow_dispatch workflows were found for this commit.',
  },
  loadFailed: {
    id: 'githubCi.dispatch.loadFailed',
    defaultMessage: 'CodePro could not load runnable workflows.',
  },
  previewFailed: {
    id: 'githubCi.dispatch.previewFailed',
    defaultMessage: 'CodePro could not verify this workflow request.',
  },
  dispatchFailed: {
    id: 'githubCi.dispatch.failed',
    defaultMessage: 'GitHub did not accept the workflow request.',
  },
  invalidResponse: {
    id: 'githubCi.dispatch.invalidResponse',
    defaultMessage: 'GitHub returned an unexpected workflow response.',
  },
  uncertain: {
    id: 'githubCi.dispatch.uncertain',
    defaultMessage:
      'The result is uncertain. Inspect GitHub before taking another action; CodePro has disabled retry.',
  },
  accepted: {
    id: 'githubCi.dispatch.accepted',
    defaultMessage: 'Workflow run accepted.',
  },
  confirmTitle: {
    id: 'githubCi.dispatch.confirmTitle',
    defaultMessage: 'Run this workflow?',
  },
  confirmMessage: {
    id: 'githubCi.dispatch.confirmMessage',
    defaultMessage:
      'This writes to GitHub. CodePro will recheck the repository, workflow schema, commit, and inputs before submitting.',
  },
  confirm: { id: 'githubCi.dispatch.confirm', defaultMessage: 'Run workflow' },
  keepEditing: { id: 'githubCi.dispatch.keepEditing', defaultMessage: 'Keep editing' },
  target: {
    id: 'githubCi.dispatch.target',
    defaultMessage: 'Branch {branch} · commit {sha}',
  },
  warning: {
    id: 'githubCi.dispatch.warning',
    defaultMessage:
      'Input values are intentionally hidden here. Review their keys, types, and sources before confirming.',
  },
});

export interface GitHubWorkflowDispatchPanelApi {
  load: (
    request: GitHubWorkflowDispatchCatalogRequest
  ) => Promise<GitHubWorkflowDispatchCatalogResponse>;
  preview: typeof acpPreviewGitHubWorkflowDispatch;
  dispatch: (request: GitHubWorkflowDispatchRequest) => Promise<GitHubWorkflowDispatchResponse>;
}

export const defaultGitHubWorkflowDispatchPanelApi: GitHubWorkflowDispatchPanelApi = {
  load: acpGetGitHubWorkflowDispatchCatalog,
  preview: acpPreviewGitHubWorkflowDispatch,
  dispatch: acpDispatchGitHubWorkflow,
};

interface GitHubWorkflowDispatchPanelProps {
  workingDirectory?: string;
  api?: GitHubWorkflowDispatchPanelApi;
  onAccepted?: () => void | Promise<void>;
}

export function GitHubWorkflowDispatchPanel({
  workingDirectory,
  api = defaultGitHubWorkflowDispatchPanelApi,
  onAccepted,
}: GitHubWorkflowDispatchPanelProps) {
  const intl = useIntl();
  const [catalog, setCatalog] = useState<GitHubWorkflowDispatchCatalogResponse>();
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<number>();
  const [values, setValues] = useState<GitHubWorkflowDispatchFormValues>({});
  const [preview, setPreview] = useState<GitHubWorkflowDispatchPreviewResponse>();
  const [previewInputs, setPreviewInputs] = useState<{ name: string; value: string }[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [accepted, setAccepted] = useState(false);
  const [retryBlocked, setRetryBlocked] = useState(false);
  const catalogRequest = useRef<
    | {
        workingDirectory: string;
        api: GitHubWorkflowDispatchPanelApi;
        promise: Promise<GitHubWorkflowDispatchCatalogResponse>;
      }
    | undefined
  >(undefined);
  const operationVersion = useRef(0);
  const busy = useRef(false);

  useEffect(() => {
    const version = ++operationVersion.current;
    busy.current = false;
    setCatalog(undefined);
    setSelectedWorkflowId(undefined);
    setValues({});
    setPreview(undefined);
    setPreviewInputs([]);
    setError(undefined);
    setAccepted(false);
    setRetryBlocked(false);
    setIsBusy(false);
    if (!workingDirectory) {
      catalogRequest.current = undefined;
      setIsLoading(false);
      return;
    }
    const request =
      catalogRequest.current?.workingDirectory === workingDirectory &&
      catalogRequest.current.api === api
        ? catalogRequest.current.promise
        : api.load({ workingDir: workingDirectory });
    catalogRequest.current = { workingDirectory, api, promise: request };
    setIsLoading(true);
    void request
      .then((result) => {
        if (operationVersion.current !== version) return;
        setCatalog(result);
        setSelectedWorkflowId(result.workflows[0]?.id);
      })
      .catch(() => {
        if (operationVersion.current === version) setError(intl.formatMessage(i18n.loadFailed));
      })
      .finally(() => {
        if (operationVersion.current === version) setIsLoading(false);
      });
    return () => {
      operationVersion.current += 1;
      busy.current = false;
    };
  }, [workingDirectory, api, intl]);

  const workflow = catalog?.workflows.find((item) => item.id === selectedWorkflowId);

  const selectWorkflow = (id: number) => {
    setSelectedWorkflowId(id);
    setValues({});
    setPreview(undefined);
    setPreviewInputs([]);
    setError(undefined);
    setAccepted(false);
  };

  const updateValue = (name: string, value: string) => {
    setValues((current) => ({ ...current, [name]: value }));
    setPreview(undefined);
    setPreviewInputs([]);
    setError(undefined);
    setAccepted(false);
  };

  const review = async () => {
    if (!workingDirectory || !catalog || !workflow || busy.current || retryBlocked) return;
    if (!dispatchRequiredInputsPresent(workflow, values)) return;
    const version = ++operationVersion.current;
    const inputs = dispatchInputValues(workflow, values);
    busy.current = true;
    setIsBusy(true);
    setError(undefined);
    setAccepted(false);
    try {
      const result = await api.preview({
        workingDir: workingDirectory,
        workflowId: workflow.id,
        inputs,
      });
      if (operationVersion.current !== version) return;
      if (!validWorkflowDispatchPreview(catalog, workflow, values, result)) {
        setError(intl.formatMessage(i18n.invalidResponse));
        return;
      }
      setPreviewInputs(inputs);
      setPreview(result);
    } catch {
      if (operationVersion.current === version) {
        setError(intl.formatMessage(i18n.previewFailed));
      }
    } finally {
      if (operationVersion.current === version) {
        busy.current = false;
        setIsBusy(false);
      }
    }
  };

  const dispatch = async () => {
    if (!workingDirectory || !preview || busy.current || retryBlocked) return;
    const confirmedPreview = preview;
    const inputs = previewInputs;
    const version = ++operationVersion.current;
    busy.current = true;
    setIsBusy(true);
    setError(undefined);
    setAccepted(false);
    try {
      const receipt = await api.dispatch({
        workingDir: workingDirectory,
        workflowId: confirmedPreview.workflow.id,
        inputs,
        preflightId: confirmedPreview.preflightId,
      });
      if (operationVersion.current !== version) return;
      setPreview(undefined);
      setPreviewInputs([]);
      if (!validWorkflowDispatchReceipt(confirmedPreview, receipt)) {
        setRetryBlocked(true);
        setError(intl.formatMessage(i18n.invalidResponse));
        return;
      }
      setAccepted(true);
      try {
        await onAccepted?.();
      } catch {
        // The GitHub write already succeeded; a follow-up refresh failure must not rewrite history.
      }
    } catch (cause) {
      if (operationVersion.current !== version) return;
      setPreview(undefined);
      setPreviewInputs([]);
      if (githubDispatchErrorCode(cause) === 'outcome_uncertain') {
        setRetryBlocked(true);
        setError(intl.formatMessage(i18n.uncertain));
      } else {
        setError(intl.formatMessage(i18n.dispatchFailed));
      }
    } finally {
      if (operationVersion.current === version) {
        busy.current = false;
        setIsBusy(false);
      }
    }
  };

  return (
    <div className="grid gap-3 rounded-md border border-border-primary p-3">
      <div>
        <h4 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <Play className="h-4 w-4" aria-hidden="true" />
          {intl.formatMessage(i18n.title)}
        </h4>
        <p className="mt-1 text-xs text-text-secondary">{intl.formatMessage(i18n.description)}</p>
      </div>

      {isLoading && (
        <p className="flex items-center gap-2 text-xs text-text-secondary">
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
          {intl.formatMessage(i18n.loading)}
        </p>
      )}
      {error && !retryBlocked && (
        <p
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-700"
        >
          {error}
        </p>
      )}
      {accepted && (
        <p
          role="status"
          className="rounded-md border border-green-300 bg-green-50 p-2 text-xs text-green-800"
        >
          {intl.formatMessage(i18n.accepted)}
        </p>
      )}
      {retryBlocked && (
        <p className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {intl.formatMessage(i18n.uncertain)}
        </p>
      )}

      {catalog && catalog.workflows.length === 0 && (
        <p className="text-xs text-text-secondary">{intl.formatMessage(i18n.noWorkflows)}</p>
      )}
      {catalog && catalog.workflows.length > 0 && workflow && (
        <div className="grid gap-3">
          <label className="grid gap-1 text-xs font-medium text-text-primary">
            {intl.formatMessage(i18n.workflow)}
            <select
              value={workflow.id}
              disabled={isBusy || retryBlocked}
              onChange={(event) => selectWorkflow(Number(event.target.value))}
              className="min-h-9 rounded-md border border-border-primary bg-background-default px-2"
            >
              {catalog.workflows.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          {workflow.inputs.map((input) => (
            <DispatchInputControl
              key={input.name}
              input={input}
              value={values[input.name] ?? ''}
              disabled={isBusy || retryBlocked}
              onChange={(value) => updateValue(input.name, value)}
            />
          ))}
          <button
            type="button"
            disabled={isBusy || retryBlocked || !dispatchRequiredInputsPresent(workflow, values)}
            onClick={() => void review()}
            className="min-h-9 rounded-md bg-blue-600 px-3 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            {intl.formatMessage(i18n.review)}
          </button>
        </div>
      )}

      <ConfirmationModal
        isOpen={Boolean(preview)}
        title={intl.formatMessage(i18n.confirmTitle)}
        message={intl.formatMessage(i18n.confirmMessage)}
        confirmLabel={intl.formatMessage(i18n.confirm)}
        cancelLabel={intl.formatMessage(i18n.keepEditing)}
        isSubmitting={isBusy}
        onCancel={() => {
          if (isBusy) return;
          setPreview(undefined);
          setPreviewInputs([]);
        }}
        onConfirm={() => void dispatch()}
        detail={preview ? <DispatchConfirmation preview={preview} /> : undefined}
      />
    </div>
  );
}

function DispatchInputControl({
  input,
  value,
  disabled,
  onChange,
}: {
  input: GitHubWorkflowDispatchWorkflow['inputs'][number];
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const intl = useIntl();
  const label = input.description || input.name;
  const suffix = input.required
    ? intl.formatMessage(i18n.required)
    : intl.formatMessage(i18n.optional);
  const shared = {
    disabled,
    value,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      onChange(event.target.value),
    className: 'min-h-9 rounded-md border border-border-primary bg-background-default px-2',
  };
  return (
    <label className="grid gap-1 text-xs font-medium text-text-primary">
      <span>
        {label} <span className="font-normal text-text-secondary">({suffix})</span>
      </span>
      {input.inputType === 'choice' ? (
        <select {...shared} aria-label={label}>
          <option value="">{intl.formatMessage(i18n.selectValue)}</option>
          {(input.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : input.inputType === 'boolean' ? (
        <select {...shared} aria-label={label}>
          <option value="">{intl.formatMessage(i18n.selectValue)}</option>
          <option value="true">{intl.formatMessage(i18n.trueValue)}</option>
          <option value="false">{intl.formatMessage(i18n.falseValue)}</option>
        </select>
      ) : (
        <input
          {...shared}
          type="text"
          inputMode={input.inputType === 'number' ? 'decimal' : undefined}
          aria-label={label}
          maxLength={4096}
        />
      )}
    </label>
  );
}

function DispatchConfirmation({ preview }: { preview: GitHubWorkflowDispatchPreviewResponse }) {
  const intl = useIntl();
  return (
    <div className="grid gap-3 text-text-primary">
      <div className="rounded-md border border-border-primary bg-background-secondary p-3">
        <p className="font-medium">
          {preview.repositoryOwner}/{preview.repositoryName}
        </p>
        <p className="mt-1 text-text-secondary">{preview.workflow.name}</p>
        <p className="mt-1 break-all font-mono text-xs text-text-secondary">
          {preview.workflow.path}
        </p>
        <p className="mt-1 font-mono text-xs text-text-secondary">
          {intl.formatMessage(i18n.target, {
            branch: preview.defaultBranch,
            sha: preview.headSha.slice(0, 7),
          })}
        </p>
      </div>
      <ul className="grid gap-1 rounded-md border border-border-primary p-3 text-xs">
        {preview.inputSummary.map((input) => (
          <li key={input.name} className="flex justify-between gap-3">
            <span className="break-all font-mono">{input.name}</span>
            <span className="text-text-secondary">
              {input.inputType} · {input.source}
            </span>
          </li>
        ))}
      </ul>
      <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
        {intl.formatMessage(i18n.warning)}
      </p>
    </div>
  );
}
