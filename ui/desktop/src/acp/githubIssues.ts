import type {
  GitHubIssueContentPreviewRequest_unstable,
  GitHubIssueContentPreviewResponse_unstable,
  GitHubIssueContentUpdateRequest_unstable,
  GitHubIssueContentUpdateResponse_unstable,
  GitHubIssueCreatePreviewRequest_unstable,
  GitHubIssueCreatePreviewResponse_unstable,
  GitHubIssueCreateRequest_unstable,
  GitHubIssueCreateResponse_unstable,
  GitHubIssueListRequest_unstable,
  GitHubIssueListResponse_unstable,
  GitHubIssueStateChangeRequest_unstable,
  GitHubIssueStateChangeResponse_unstable,
  GitHubIssueStatePreviewRequest_unstable,
  GitHubIssueStatePreviewResponse_unstable,
} from '@aaif/goose-sdk';
import { getAcpClient } from './acpConnection';

export type GitHubIssue = GitHubIssueListResponse_unstable['issues'][number];
export type GitHubIssueCreatePreviewResponse = GitHubIssueCreatePreviewResponse_unstable;
export type GitHubIssueContentPreviewResponse = GitHubIssueContentPreviewResponse_unstable;
export type GitHubIssueStatePreviewResponse = GitHubIssueStatePreviewResponse_unstable;

export async function acpListGitHubIssues(
  request: GitHubIssueListRequest_unstable
): Promise<GitHubIssueListResponse_unstable> {
  const client = await getAcpClient();
  return client.goose.githubIssuesList_unstable(request);
}

export async function acpPreviewGitHubIssueCreate(
  request: GitHubIssueCreatePreviewRequest_unstable
): Promise<GitHubIssueCreatePreviewResponse_unstable> {
  const client = await getAcpClient();
  return client.goose.githubIssuesCreatePreview_unstable(request);
}

export async function acpCreateGitHubIssue(
  request: GitHubIssueCreateRequest_unstable
): Promise<GitHubIssueCreateResponse_unstable> {
  const client = await getAcpClient();
  return client.goose.githubIssuesCreate_unstable(request);
}

export async function acpPreviewGitHubIssueContent(
  request: GitHubIssueContentPreviewRequest_unstable
): Promise<GitHubIssueContentPreviewResponse_unstable> {
  const client = await getAcpClient();
  return client.goose.githubIssuesContentPreview_unstable(request);
}

export async function acpUpdateGitHubIssueContent(
  request: GitHubIssueContentUpdateRequest_unstable
): Promise<GitHubIssueContentUpdateResponse_unstable> {
  const client = await getAcpClient();
  return client.goose.githubIssuesContentUpdate_unstable(request);
}

export async function acpPreviewGitHubIssueState(
  request: GitHubIssueStatePreviewRequest_unstable
): Promise<GitHubIssueStatePreviewResponse_unstable> {
  const client = await getAcpClient();
  return client.goose.githubIssuesStatePreview_unstable(request);
}

export async function acpChangeGitHubIssueState(
  request: GitHubIssueStateChangeRequest_unstable
): Promise<GitHubIssueStateChangeResponse_unstable> {
  const client = await getAcpClient();
  return client.goose.githubIssuesStateChange_unstable(request);
}
