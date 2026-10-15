import React from 'react';
import ReactDOM from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import {
  GitHubPullRequestPanel,
  type GitHubPullRequestPanelApi,
} from '../../src/components/codepro/GitHubPullRequestPanel';
import { applyThemeTokens } from '../../src/theme/theme-tokens';

applyThemeTokens();

const preflightId = 'a'.repeat(64);
const api: GitHubPullRequestPanelApi = {
  preview: async (request) => ({
    preflightId,
    repositoryOwner: 'octo',
    repositoryName: 'demo',
    repositoryUrl: 'https://github.com/octo/demo',
    headBranch: 'feature/pr-flow',
    headSha: '1'.repeat(40),
    baseBranch: request.baseBranch ?? 'main',
    baseSha: '2'.repeat(40),
    commitCount: 2,
    changedFileCount: 3,
    draft: request.draft,
    maintainerCanModify: request.maintainerCanModify,
  }),
  create: async (request) => ({
    number: 42,
    title: request.title,
    state: 'open',
    htmlUrl: 'https://github.com/octo/demo/pull/42',
    headBranch: 'feature/pr-flow',
    baseBranch: request.baseBranch ?? 'main',
    draft: request.draft,
  }),
};

(window as unknown as { electron: { openExternal: (url: string) => Promise<void> } }).electron = {
  openExternal: async (url) => {
    document.body.dataset.openedUrl = url;
  },
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <IntlProvider locale="en" defaultLocale="en" onError={() => {}}>
      <main className="mx-auto h-screen w-full max-w-[420px] overflow-y-auto p-3">
        <GitHubPullRequestPanel workingDirectory="D:\\CodeBuddy" api={api} />
      </main>
    </IntlProvider>
  </React.StrictMode>
);
