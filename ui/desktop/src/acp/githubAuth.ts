import type {
  GitHubAuthPollResponse_unstable,
  GitHubAuthStartResponse_unstable,
  GitHubAuthStatusResponse_unstable,
} from '@aaif/goose-sdk';
import { getAcpClient } from './acpConnection';

export type {
  GitHubAuthPollResponse_unstable,
  GitHubAuthStartResponse_unstable,
  GitHubAuthStatusResponse_unstable,
};

export const GITHUB_VERIFICATION_URI = 'https://github.com/login/device';

export async function acpGitHubAuthStatus(): Promise<GitHubAuthStatusResponse_unstable> {
  const client = await getAcpClient();
  return client.goose.githubAuthStatus_unstable({});
}

export async function acpStartGitHubAuth(): Promise<GitHubAuthStartResponse_unstable> {
  const client = await getAcpClient();
  return client.goose.githubAuthStart_unstable({});
}

export async function acpPollGitHubAuth(flowId: string): Promise<GitHubAuthPollResponse_unstable> {
  const client = await getAcpClient();
  return client.goose.githubAuthPoll_unstable({ flowId });
}

export async function acpCancelGitHubAuth(flowId: string): Promise<void> {
  const client = await getAcpClient();
  await client.goose.githubAuthCancel_unstable({ flowId });
}

export async function acpDisconnectGitHubAuth(): Promise<void> {
  const client = await getAcpClient();
  await client.goose.githubAuthDisconnect_unstable({});
}
