import { StrictMode } from 'react';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectCodeProWorkspace } from '../../codepro/projectWorkspace';
import type { CodeProWorkspaceInspection } from '../../codepro/projectWorkspace';
import { normalizeWorkspaceIdentity } from '../../codepro/workspaceIdentity';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { CodeProWorkspaceReconfirmation } from './CodeProWorkspaceReconfirmation';

const request = {
  sessionId: 'session-1',
  workingDir: 'D:\\Projects\\Ledger',
};

const candidate = {
  requestedPath: request.workingDir,
  normalizedPath: request.workingDir,
  normalizedIdentity: 'd:\\projects\\ledger',
  canonicalPath: request.workingDir,
  source: 'prompt' as const,
  state: 'non-empty-directory' as const,
  isGitRepository: true,
  displayName: 'Ledger',
  suggestedProjectId: 'ledger-a1b2c3d4e5f6',
  error: null,
};

describe('CodeProWorkspaceReconfirmation', () => {
  it('automatically resumes a real existing directory without changing its files', async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'codepro-reconfirm-'));
    try {
      const workingDir = path.join(await fs.realpath(fixture), '中文 Project (保留)');
      await fs.mkdir(workingDir);
      const sentinel = path.join(workingDir, 'preserve.txt');
      await fs.writeFile(sentinel, 'existing project\n');
      const onConfirm = vi.fn();
      render(
        <CodeProWorkspaceReconfirmation
          request={{ ...request, workingDir }}
          confirming={false}
          error={null}
          onConfirm={onConfirm}
          onCancel={vi.fn()}
          inspectWorkspace={inspectCodeProWorkspace}
        />,
        { wrapper: IntlTestWrapper }
      );
      await waitFor(() =>
        expect(onConfirm).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ canonicalPath: workingDir, state: 'non-empty-directory' })
        )
      );
      expect(screen.queryByRole('button', { name: 'Confirm and start' })).toBeNull();
      expect(await fs.readdir(workingDir)).toEqual(['preserve.txt']);
      expect(await fs.readFile(sentinel, 'utf8')).toBe('existing project\n');
    } finally {
      await fs.rm(fixture, { recursive: true, force: true });
    }
  });

  it('automatically resumes a restored directory after an explicit retry', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const inspectWorkspace = vi
      .fn()
      .mockResolvedValueOnce([{ ...candidate, state: 'missing' }])
      .mockResolvedValueOnce([candidate]);
    render(
      <CodeProWorkspaceReconfirmation
        request={request}
        confirming={false}
        error={null}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
        inspectWorkspace={inspectWorkspace}
      />,
      { wrapper: IntlTestWrapper }
    );
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(onConfirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledExactlyOnceWith(candidate));
    expect(inspectWorkspace).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Confirm and start' })).toBeNull();
  });

  it.each([request.workingDir, '/Users/dev/Projects/Ledger', '/Users/dev/中文 项目 (保留)'])(
    'resumes the exact persisted workspace %s without another directory question',
    async (workingDir) => {
      const persistedRequest = { sessionId: 'session-1', workingDir };
      const exact = {
        ...candidate,
        requestedPath: workingDir,
        normalizedPath: workingDir,
        normalizedIdentity: normalizeWorkspaceIdentity(workingDir),
        canonicalPath: workingDir,
      };
      const onConfirm = vi.fn();
      const inspectWorkspace = vi.fn().mockResolvedValue([exact]);
      render(
        <StrictMode>
          <CodeProWorkspaceReconfirmation
            request={persistedRequest}
            confirming={false}
            error={null}
            onConfirm={onConfirm}
            onCancel={vi.fn()}
            inspectWorkspace={inspectWorkspace}
          />
        </StrictMode>,
        { wrapper: IntlTestWrapper }
      );
      await waitFor(() => expect(onConfirm).toHaveBeenCalledExactlyOnceWith(exact));
      expect(inspectWorkspace).toHaveBeenCalledWith({
        prompt: `Resume the existing project at "${workingDir}"`,
        selectedWorkingDir: workingDir,
      });
      expect(screen.queryByRole('heading', { name: 'Confirm project workspace' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Confirm and start' })).toBeNull();
    }
  );

  it.each([
    [request.workingDir, 'D:\\Changed\\Ledger'],
    ['/Users/dev/Projects/Ledger', '/Users/dev/Projects/ledger'],
  ])('rejects changed canonical identity %s -> %s', async (workingDir, different) => {
    const onConfirm = vi.fn();
    const changedCandidate = {
      ...candidate,
      normalizedPath: different,
      normalizedIdentity: normalizeWorkspaceIdentity(different),
      canonicalPath: different,
    };
    render(
      <CodeProWorkspaceReconfirmation
        request={{ sessionId: 'session-1', workingDir }}
        confirming={false}
        error={null}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
        inspectWorkspace={vi.fn().mockResolvedValue([changedCandidate])}
      />,
      { wrapper: IntlTestWrapper }
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The persisted workspace no longer matches the inspected directory.'
    );
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('keeps inspection failures actionable and lets the user leave', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <CodeProWorkspaceReconfirmation
        request={request}
        confirming={false}
        error={null}
        onConfirm={onConfirm}
        onCancel={onCancel}
        inspectWorkspace={vi.fn().mockRejectedValue(new Error('workspace unavailable'))}
      />,
      { wrapper: IntlTestWrapper }
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The persisted workspace is unavailable.'
    );
    expect(onConfirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('does not loop after a resume failure or callback rerender; retries only on demand', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const inspectWorkspace = vi.fn().mockResolvedValue([candidate]);
    const props = {
      request,
      confirming: false,
      error: null as string | null,
      onConfirm,
      onCancel: vi.fn(),
      inspectWorkspace,
    };
    const { rerender } = render(<CodeProWorkspaceReconfirmation {...props} />, {
      wrapper: IntlTestWrapper,
    });
    await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
    const retryConfirm = vi.fn();
    rerender(
      <CodeProWorkspaceReconfirmation
        {...props}
        onConfirm={retryConfirm}
        error="ACP load failed"
      />
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('ACP load failed');
    expect(inspectWorkspace).toHaveBeenCalledOnce();
    expect(retryConfirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(retryConfirm).toHaveBeenCalledExactlyOnceWith(candidate));
    expect(inspectWorkspace).toHaveBeenCalledTimes(2);
  });

  it('ignores a pending inspection after switching to another conversation', async () => {
    let finishOldInspection!: (value: CodeProWorkspaceInspection[]) => void;
    const onConfirm = vi.fn();
    const inspectWorkspace = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<CodeProWorkspaceInspection[]>((resolve) => (finishOldInspection = resolve))
      )
      .mockResolvedValueOnce([candidate]);
    const props = {
      request,
      confirming: false,
      error: null,
      onConfirm,
      onCancel: vi.fn(),
      inspectWorkspace,
    };
    const { rerender } = render(<CodeProWorkspaceReconfirmation {...props} />, {
      wrapper: IntlTestWrapper,
    });
    rerender(
      <CodeProWorkspaceReconfirmation {...props} request={{ ...request, sessionId: 'session-2' }} />
    );
    await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
    await act(async () => finishOldInspection([candidate]));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
