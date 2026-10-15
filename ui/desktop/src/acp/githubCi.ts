import type {
  GitHubCiArtifactsRequest_unstable,
  GitHubCiArtifactsResponse_unstable,
  GitHubCiCancelPreviewRequest_unstable,
  GitHubCiCancelPreviewResponse_unstable,
  GitHubCiCancelRequest_unstable,
  GitHubCiCancelResponse_unstable,
  GitHubCiRerunPreviewRequest_unstable,
  GitHubCiRerunPreviewResponse_unstable,
  GitHubCiRerunRequest_unstable,
  GitHubCiRerunResponse_unstable,
  GitHubCiStatusRequest_unstable,
  GitHubCiStatusResponse_unstable,
  GitHubWorkflowDispatchCatalogRequest_unstable,
  GitHubWorkflowDispatchCatalogResponse_unstable,
  GitHubWorkflowDispatchPreviewRequest_unstable,
  GitHubWorkflowDispatchPreviewResponse_unstable,
  GitHubWorkflowDispatchRequest_unstable,
  GitHubWorkflowDispatchResponse_unstable,
} from '@aaif/goose-sdk';
import { getAcpClient } from './acpConnection';

export type GitHubCiStatusRequest = GitHubCiStatusRequest_unstable;
export type GitHubCiStatusResponse = GitHubCiStatusResponse_unstable;
export type GitHubCiArtifactsRequest = GitHubCiArtifactsRequest_unstable;
export type GitHubCiArtifactsResponse = GitHubCiArtifactsResponse_unstable;
export type GitHubCiRerunPreviewRequest = GitHubCiRerunPreviewRequest_unstable;
export type GitHubCiRerunPreviewResponse = GitHubCiRerunPreviewResponse_unstable;
export type GitHubCiRerunRequest = GitHubCiRerunRequest_unstable;
export type GitHubCiRerunResponse = GitHubCiRerunResponse_unstable;
export type GitHubCiCancelPreviewRequest = GitHubCiCancelPreviewRequest_unstable;
export type GitHubCiCancelPreviewResponse = GitHubCiCancelPreviewResponse_unstable;
export type GitHubCiCancelRequest = GitHubCiCancelRequest_unstable;
export type GitHubCiCancelResponse = GitHubCiCancelResponse_unstable;
export type GitHubWorkflowDispatchCatalogRequest = GitHubWorkflowDispatchCatalogRequest_unstable;
export type GitHubWorkflowDispatchCatalogResponse = GitHubWorkflowDispatchCatalogResponse_unstable;
export type GitHubWorkflowDispatchPreviewRequest = GitHubWorkflowDispatchPreviewRequest_unstable;
export type GitHubWorkflowDispatchPreviewResponse = GitHubWorkflowDispatchPreviewResponse_unstable;
export type GitHubWorkflowDispatchRequest = GitHubWorkflowDispatchRequest_unstable;
export type GitHubWorkflowDispatchResponse = GitHubWorkflowDispatchResponse_unstable;

export async function acpGetGitHubCiStatus(
  request: GitHubCiStatusRequest
): Promise<GitHubCiStatusResponse> {
  const client = await getAcpClient();
  return client.goose.githubCiStatus_unstable(request);
}

export async function acpGetGitHubCiArtifacts(
  request: GitHubCiArtifactsRequest
): Promise<GitHubCiArtifactsResponse> {
  const client = await getAcpClient();
  return client.goose.githubCiArtifacts_unstable(request);
}

export async function acpPreviewGitHubCiRerun(
  request: GitHubCiRerunPreviewRequest
): Promise<GitHubCiRerunPreviewResponse> {
  const client = await getAcpClient();
  return client.goose.githubCiRerunFailedJobsPreview_unstable(request);
}

export async function acpRerunFailedGitHubCiJobs(
  request: GitHubCiRerunRequest
): Promise<GitHubCiRerunResponse> {
  const client = await getAcpClient();
  return client.goose.githubCiRerunFailedJobs_unstable(request);
}

export async function acpPreviewGitHubCiCancel(
  request: GitHubCiCancelPreviewRequest
): Promise<GitHubCiCancelPreviewResponse> {
  const client = await getAcpClient();
  return client.goose.githubCiCancelPreview_unstable(request);
}

export async function acpCancelGitHubCiRun(
  request: GitHubCiCancelRequest
): Promise<GitHubCiCancelResponse> {
  const client = await getAcpClient();
  return client.goose.githubCiCancel_unstable(request);
}

export async function acpGetGitHubWorkflowDispatchCatalog(
  request: GitHubWorkflowDispatchCatalogRequest
): Promise<GitHubWorkflowDispatchCatalogResponse> {
  const client = await getAcpClient();
  return client.goose.githubCiWorkflows_unstable(request);
}

export async function acpPreviewGitHubWorkflowDispatch(
  request: GitHubWorkflowDispatchPreviewRequest
): Promise<GitHubWorkflowDispatchPreviewResponse> {
  const client = await getAcpClient();
  return client.goose.githubCiDispatchPreview_unstable(request);
}

export async function acpDispatchGitHubWorkflow(
  request: GitHubWorkflowDispatchRequest
): Promise<GitHubWorkflowDispatchResponse> {
  const client = await getAcpClient();
  return client.goose.githubCiDispatch_unstable(request);
}
