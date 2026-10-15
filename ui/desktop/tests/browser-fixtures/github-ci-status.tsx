import ReactDOM from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import {
  GitHubCiStatusPanel,
  type GitHubCiStatusPanelApi,
} from '../../src/components/codepro/GitHubCiStatusPanel';
import { applyThemeTokens } from '../../src/theme/theme-tokens';

applyThemeTokens();

const failedRun = {
  id: 40,
  name: 'Windows validation',
  runNumber: 7,
  attempt: 2,
  event: 'push',
  status: 'completed' as const,
  conclusion: 'failure' as const,
  htmlUrl: 'https://github.com/octo/demo/actions/runs/40',
  createdAt: '2026-08-04T23:00:00Z',
  updatedAt: '2026-08-04T23:10:00Z',
};

const api: GitHubCiStatusPanelApi = {
  load: async () => {
    const loadCount = Number(document.body.dataset.loadCount ?? '0') + 1;
    document.body.dataset.loadCount = String(loadCount);
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    return {
      repositoryOwner: 'octo',
      repositoryName: 'demo',
      repositoryUrl: 'https://github.com/octo/demo',
      branch: 'main',
      headSha: '1111111111111111111111111111111111111111',
      workingTreeDirty: true,
      aggregateStatus: loadCount > 1 ? ('success' as const) : ('in_progress' as const),
      totalCount: 8,
      truncated: true,
      runs: [
        {
          id: 42,
          name: 'Build, test, and security checks',
          runNumber: 9,
          attempt: 1,
          event: 'push',
          status: 'in_progress',
          conclusion: null,
          htmlUrl: 'https://github.com/octo/demo/actions/runs/42',
          createdAt: '2026-08-05T01:00:00Z',
          updatedAt: '2026-08-05T01:01:00Z',
        },
        failedRun,
        {
          id: 41,
          name: 'Dependency review',
          runNumber: 8,
          attempt: 2,
          event: 'pull_request',
          status: 'completed',
          conclusion: 'success',
          htmlUrl: 'https://github.com/octo/demo/actions/runs/41',
          createdAt: '2026-08-05T00:00:00Z',
          updatedAt: '2026-08-05T00:10:00Z',
        },
      ],
    };
  },
  preview: async ({ runId }) => {
    document.body.dataset.previewCount = String(
      Number(document.body.dataset.previewCount ?? '0') + 1
    );
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    if (runId !== failedRun.id) throw new Error('Unexpected run ID');
    return {
      preflightId: 'a'.repeat(64),
      repositoryOwner: 'octo',
      repositoryName: 'demo',
      repositoryUrl: 'https://github.com/octo/demo',
      branch: 'main',
      headSha: '1111111111111111111111111111111111111111',
      workingTreeDirty: true,
      run: failedRun,
    };
  },
  rerun: async ({ runId }) => {
    document.body.dataset.rerunCount = String(Number(document.body.dataset.rerunCount ?? '0') + 1);
    await new Promise((resolve) => window.setTimeout(resolve, 200));
    if (new URLSearchParams(window.location.search).get('outcome') === 'uncertain') {
      throw new Error('The failed-jobs rerun outcome is uncertain; inspect GitHub before retrying');
    }
    return {
      repositoryOwner: 'octo',
      repositoryName: 'demo',
      repositoryUrl: 'https://github.com/octo/demo',
      branch: 'main',
      headSha: '1111111111111111111111111111111111111111',
      runId,
      runUrl: `https://github.com/octo/demo/actions/runs/${runId}`,
      previousAttempt: failedRun.attempt,
      auditId: 'browser-fixture-audit',
      acceptedAt: '2026-08-05T02:00:00Z',
    };
  },
};

(window as unknown as { electron: { openExternal: (url: string) => Promise<void> } }).electron = {
  openExternal: async (url) => {
    document.body.dataset.openedUrl = url;
  },
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <IntlProvider locale="en" defaultLocale="en" onError={() => {}}>
    <main className="mx-auto h-screen w-full max-w-[420px] overflow-y-auto p-3">
      <GitHubCiStatusPanel workingDirectory="D:\CodeBuddy" api={api} />
    </main>
  </IntlProvider>
);
