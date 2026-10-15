import type { GitHubWorkflowDispatchWorkflow } from '@aaif/goose-sdk';
import type {
  GitHubWorkflowDispatchCatalogResponse,
  GitHubWorkflowDispatchPreviewResponse,
  GitHubWorkflowDispatchResponse,
} from '../../acp/githubCi';

export type GitHubWorkflowDispatchFormValues = Record<string, string>;

export function dispatchInputValues(
  workflow: GitHubWorkflowDispatchWorkflow,
  values: GitHubWorkflowDispatchFormValues
) {
  return workflow.inputs
    .filter((input) => (values[input.name] ?? '') !== '')
    .map((input) => ({ name: input.name, value: values[input.name] }));
}

export function dispatchRequiredInputsPresent(
  workflow: GitHubWorkflowDispatchWorkflow,
  values: GitHubWorkflowDispatchFormValues
): boolean {
  return workflow.inputs.every(
    (input) => !input.required || input.defaultValue !== undefined || Boolean(values[input.name])
  );
}

export function validWorkflowDispatchPreview(
  catalog: GitHubWorkflowDispatchCatalogResponse,
  workflow: GitHubWorkflowDispatchWorkflow,
  values: GitHubWorkflowDispatchFormValues,
  preview: GitHubWorkflowDispatchPreviewResponse
): boolean {
  return (
    preview.preflightId.length === 64 &&
    /^[0-9a-f]+$/.test(preview.preflightId) &&
    preview.repositoryOwner === catalog.repositoryOwner &&
    preview.repositoryName === catalog.repositoryName &&
    preview.repositoryUrl === catalog.repositoryUrl &&
    preview.defaultBranch === catalog.defaultBranch &&
    preview.headSha === catalog.headSha &&
    JSON.stringify(preview.workflow) === JSON.stringify(workflow) &&
    preview.inputSummary.length === workflow.inputs.length &&
    preview.inputSummary.every((summary, index) => {
      const input = workflow.inputs[index];
      const expectedSource = values[input.name]
        ? 'provided'
        : input.defaultValue !== undefined
          ? 'default'
          : 'omitted';
      return (
        summary.name === input.name &&
        summary.inputType === input.inputType &&
        summary.source === expectedSource
      );
    })
  );
}

export function validWorkflowDispatchReceipt(
  preview: GitHubWorkflowDispatchPreviewResponse,
  receipt: GitHubWorkflowDispatchResponse
): boolean {
  try {
    const url = new URL(receipt.runUrl);
    return (
      receipt.repositoryOwner === preview.repositoryOwner &&
      receipt.repositoryName === preview.repositoryName &&
      receipt.repositoryUrl === preview.repositoryUrl &&
      receipt.defaultBranch === preview.defaultBranch &&
      receipt.headSha === preview.headSha &&
      receipt.workflowId === preview.workflow.id &&
      receipt.workflowName === preview.workflow.name &&
      receipt.workflowPath === preview.workflow.path &&
      receipt.runId > 0 &&
      receipt.auditId.length > 0 &&
      receipt.acceptedAt.length > 0 &&
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.username === '' &&
      url.password === '' &&
      url.port === '' &&
      url.search === '' &&
      url.hash === '' &&
      url.pathname ===
        `/${preview.repositoryOwner}/${preview.repositoryName}/actions/runs/${receipt.runId}`
    );
  } catch {
    return false;
  }
}

export function githubDispatchErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const data = 'data' in error ? error.data : undefined;
  if (!data || typeof data !== 'object' || !('code' in data)) return undefined;
  return typeof data.code === 'string' ? data.code : undefined;
}
