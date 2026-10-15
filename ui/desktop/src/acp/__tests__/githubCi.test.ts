import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAcpClient } from '../acpConnection';
import {
  acpCancelGitHubCiRun,
  acpGetGitHubCiArtifacts,
  acpGetGitHubCiStatus,
  acpGetGitHubWorkflowDispatchCatalog,
  acpPreviewGitHubWorkflowDispatch,
  acpDispatchGitHubWorkflow,
  acpPreviewGitHubCiCancel,
  acpPreviewGitHubCiRerun,
  acpRerunFailedGitHubCiJobs,
} from '../githubCi';

vi.mock('../acpConnection', () => ({
  getAcpClient: vi.fn(),
}));

describe('GitHub CI ACP wrapper', () => {
  const githubCiStatus = vi.fn();
  const githubCiArtifacts = vi.fn();
  const githubCiRerunPreview = vi.fn();
  const githubCiRerun = vi.fn();
  const githubCiCancelPreview = vi.fn();
  const githubCiCancel = vi.fn();
  const githubCiWorkflows = vi.fn();
  const githubCiDispatchPreview = vi.fn();
  const githubCiDispatch = vi.fn();

  beforeEach(() => {
    githubCiStatus.mockReset().mockResolvedValue({ runs: [] });
    githubCiArtifacts.mockReset().mockResolvedValue({ artifacts: [] });
    githubCiRerunPreview.mockReset().mockResolvedValue({ preflightId: 'a'.repeat(64) });
    githubCiRerun.mockReset().mockResolvedValue({ runId: 42 });
    githubCiCancelPreview.mockReset().mockResolvedValue({ preflightId: 'c'.repeat(64) });
    githubCiCancel.mockReset().mockResolvedValue({ runId: 42 });
    githubCiWorkflows.mockReset().mockResolvedValue({ workflows: [] });
    githubCiDispatchPreview.mockReset().mockResolvedValue({ preflightId: 'd'.repeat(64) });
    githubCiDispatch.mockReset().mockResolvedValue({ runId: 9001 });
    vi.mocked(getAcpClient).mockResolvedValue({
      goose: {
        githubCiStatus_unstable: githubCiStatus,
        githubCiArtifacts_unstable: githubCiArtifacts,
        githubCiRerunFailedJobsPreview_unstable: githubCiRerunPreview,
        githubCiRerunFailedJobs_unstable: githubCiRerun,
        githubCiCancelPreview_unstable: githubCiCancelPreview,
        githubCiCancel_unstable: githubCiCancel,
        githubCiWorkflows_unstable: githubCiWorkflows,
        githubCiDispatchPreview_unstable: githubCiDispatchPreview,
        githubCiDispatch_unstable: githubCiDispatch,
      },
    } as unknown as Awaited<ReturnType<typeof getAcpClient>>);
  });

  it('delegates the bounded working directory request to the generated SDK method', async () => {
    const request = { workingDir: 'D:\\project' };

    await acpGetGitHubCiStatus(request);

    expect(githubCiStatus).toHaveBeenCalledTimes(1);
    expect(githubCiStatus).toHaveBeenCalledWith(request);
  });

  it('delegates exact-run artifact metadata to the generated read-only method', async () => {
    const request = { workingDir: 'D:\\project', runId: 42 };

    await acpGetGitHubCiArtifacts(request);

    expect(githubCiArtifacts).toHaveBeenCalledTimes(1);
    expect(githubCiArtifacts).toHaveBeenCalledWith(request);
  });

  it('delegates preview and execute to their generated bounded methods', async () => {
    const previewRequest = { workingDir: 'D:\\project', runId: 42 };
    const executeRequest = {
      ...previewRequest,
      preflightId: 'a'.repeat(64),
    };

    await acpPreviewGitHubCiRerun(previewRequest);
    await acpRerunFailedGitHubCiJobs(executeRequest);

    expect(githubCiRerunPreview).toHaveBeenCalledTimes(1);
    expect(githubCiRerunPreview).toHaveBeenCalledWith(previewRequest);
    expect(githubCiRerun).toHaveBeenCalledTimes(1);
    expect(githubCiRerun).toHaveBeenCalledWith(executeRequest);
  });

  it('delegates cancellation preview and execute to their generated bounded methods', async () => {
    const previewRequest = { workingDir: 'D:\\project', runId: 42 };
    const executeRequest = {
      ...previewRequest,
      preflightId: 'c'.repeat(64),
    };

    await acpPreviewGitHubCiCancel(previewRequest);
    await acpCancelGitHubCiRun(executeRequest);

    expect(githubCiCancelPreview).toHaveBeenCalledTimes(1);
    expect(githubCiCancelPreview).toHaveBeenCalledWith(previewRequest);
    expect(githubCiCancel).toHaveBeenCalledTimes(1);
    expect(githubCiCancel).toHaveBeenCalledWith(executeRequest);
  });

  it('delegates workflow catalog, preview, and execute to generated bounded methods', async () => {
    const catalogRequest = { workingDir: 'D:\\project' };
    const previewRequest = {
      ...catalogRequest,
      workflowId: 42,
      inputs: [{ name: 'channel', value: 'beta' }],
    };
    const executeRequest = { ...previewRequest, preflightId: 'd'.repeat(64) };

    await acpGetGitHubWorkflowDispatchCatalog(catalogRequest);
    await acpPreviewGitHubWorkflowDispatch(previewRequest);
    await acpDispatchGitHubWorkflow(executeRequest);

    expect(githubCiWorkflows).toHaveBeenCalledWith(catalogRequest);
    expect(githubCiDispatchPreview).toHaveBeenCalledWith(previewRequest);
    expect(githubCiDispatch).toHaveBeenCalledWith(executeRequest);
  });
});
