import type { GitHubCiRun } from '@aaif/goose-sdk';
import type {
  GitHubCiRerunPreviewResponse,
  GitHubCiRerunResponse,
  GitHubCiStatusResponse,
} from '../../acp/githubCi';

export function eligibleForRerun(run: GitHubCiRun): boolean {
  return (
    run.id > 0 &&
    run.status === 'completed' &&
    (run.conclusion === 'failure' || run.conclusion === 'timed_out')
  );
}

export function validRerunPreview(
  status: GitHubCiStatusResponse,
  run: GitHubCiRun,
  preview: GitHubCiRerunPreviewResponse
): boolean {
  return (
    preview.repositoryOwner === status.repositoryOwner &&
    preview.repositoryName === status.repositoryName &&
    preview.repositoryUrl === status.repositoryUrl &&
    preview.branch === status.branch &&
    preview.headSha === status.headSha &&
    preview.run.id === run.id &&
    preview.run.name === run.name &&
    preview.run.runNumber === run.runNumber &&
    preview.run.attempt === run.attempt &&
    preview.run.status === run.status &&
    preview.run.conclusion === run.conclusion &&
    preview.run.updatedAt === run.updatedAt &&
    preview.preflightId.length === 64 &&
    /^[0-9a-f]+$/.test(preview.preflightId)
  );
}

export function validRerunReceipt(
  preview: GitHubCiRerunPreviewResponse,
  receipt: GitHubCiRerunResponse
): boolean {
  try {
    const url = new URL(receipt.runUrl);
    return (
      receipt.repositoryOwner === preview.repositoryOwner &&
      receipt.repositoryName === preview.repositoryName &&
      receipt.repositoryUrl === preview.repositoryUrl &&
      receipt.branch === preview.branch &&
      receipt.headSha === preview.headSha &&
      receipt.runId === preview.run.id &&
      receipt.previousAttempt === preview.run.attempt &&
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
        `/${preview.repositoryOwner}/${preview.repositoryName}/actions/runs/${preview.run.id}`
    );
  } catch {
    return false;
  }
}

export function safeError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}
