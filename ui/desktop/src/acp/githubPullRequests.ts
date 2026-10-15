import type {
  GitHubDeliveryStatusRequest_unstable,
  GitHubDeliveryStatusResponse_unstable,
  GitHubPullRequestCreateRequest_unstable,
  GitHubPullRequestCreateResponse_unstable,
  GitHubPullRequestContentPreviewRequest_unstable,
  GitHubPullRequestContentPreviewResponse_unstable,
  GitHubPullRequestContentUpdateRequest_unstable,
  GitHubPullRequestContentUpdateResponse_unstable,
  GitHubPullRequestPreviewRequest_unstable,
  GitHubPullRequestPreviewResponse_unstable,
  GitHubPullRequestStateChangeRequest_unstable,
  GitHubPullRequestStateChangeResponse_unstable,
  GitHubPullRequestStatePreviewRequest_unstable,
  GitHubPullRequestStatePreviewResponse_unstable,
} from '@aaif/goose-sdk';
import { getAcpClient } from './acpConnection';

export type GitHubPullRequestPreviewRequest = GitHubPullRequestPreviewRequest_unstable;
export type GitHubPullRequestPreviewResponse = GitHubPullRequestPreviewResponse_unstable;
export type GitHubPullRequestCreateRequest = GitHubPullRequestCreateRequest_unstable;
export type GitHubPullRequestCreateResponse = GitHubPullRequestCreateResponse_unstable;
export type GitHubPullRequestContentPreviewRequest =
  GitHubPullRequestContentPreviewRequest_unstable;
export type GitHubPullRequestContentPreviewResponse =
  GitHubPullRequestContentPreviewResponse_unstable;
export type GitHubPullRequestContentUpdateRequest = GitHubPullRequestContentUpdateRequest_unstable;
export type GitHubPullRequestContentUpdateResponse =
  GitHubPullRequestContentUpdateResponse_unstable;
export type GitHubPullRequestStatePreviewRequest = GitHubPullRequestStatePreviewRequest_unstable;
export type GitHubPullRequestStatePreviewResponse = GitHubPullRequestStatePreviewResponse_unstable;
export type GitHubPullRequestStateChangeRequest = GitHubPullRequestStateChangeRequest_unstable;
export type GitHubPullRequestStateChangeResponse = GitHubPullRequestStateChangeResponse_unstable;
export type GitHubDeliveryStatusRequest = GitHubDeliveryStatusRequest_unstable;
export type GitHubDeliveryStatusResponse = GitHubDeliveryStatusResponse_unstable;

export async function acpGitHubDeliveryStatus(
  request: GitHubDeliveryStatusRequest
): Promise<GitHubDeliveryStatusResponse> {
  const client = await getAcpClient();
  return client.goose.githubDeliveryStatus_unstable(request);
}

export async function acpPreviewGitHubPullRequest(
  request: GitHubPullRequestPreviewRequest
): Promise<GitHubPullRequestPreviewResponse> {
  const client = await getAcpClient();
  return client.goose.githubPullRequestPreview_unstable(request);
}

export async function acpCreateGitHubPullRequest(
  request: GitHubPullRequestCreateRequest
): Promise<GitHubPullRequestCreateResponse> {
  const client = await getAcpClient();
  return client.goose.githubPullRequestCreate_unstable(request);
}

export async function acpPreviewGitHubPullRequestState(
  request: GitHubPullRequestStatePreviewRequest
): Promise<GitHubPullRequestStatePreviewResponse> {
  const client = await getAcpClient();
  return client.goose.githubPullRequestStatePreview_unstable(request);
}

export async function acpChangeGitHubPullRequestState(
  request: GitHubPullRequestStateChangeRequest
): Promise<GitHubPullRequestStateChangeResponse> {
  const client = await getAcpClient();
  return client.goose.githubPullRequestStateChange_unstable(request);
}

export async function acpPreviewGitHubPullRequestContent(
  request: GitHubPullRequestContentPreviewRequest
): Promise<GitHubPullRequestContentPreviewResponse> {
  const client = await getAcpClient();
  return client.goose.githubPullRequestContentPreview_unstable(request);
}

export async function acpUpdateGitHubPullRequestContent(
  request: GitHubPullRequestContentUpdateRequest
): Promise<GitHubPullRequestContentUpdateResponse> {
  const client = await getAcpClient();
  return client.goose.githubPullRequestContentUpdate_unstable(request);
}
