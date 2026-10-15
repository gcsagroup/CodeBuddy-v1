export type GitHubCliStatus = {
  state: 'connected' | 'disconnected' | 'unavailable' | 'check_failed' | 'restart_required';
  login?: string;
};
export type GitHubCliChallenge = { flowId: string; userCode: string; expiresAt: number };
export type GitHubCliPoll = { state: 'pending' | 'connected' | 'failed'; login?: string };
