import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectCodeProWorkspace } from '../../codepro/projectWorkspace';
import { normalizeWorkspaceIdentity } from '../../codepro/workspaceIdentity';
import { render, screen, waitFor } from '@testing-library/react';
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
  it('reconfirms a real native directory without changing its existing files', async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'codepro-reconfirm-'));
    try {
      const workingDir = path.join(await fs.realpath(fixture), '中文 Project (保留)');
      await fs.mkdir(workingDir);
      const sentinel = path.join(workingDir, 'preserve.txt');
      await fs.writeFile(sentinel, 'existing project\n');
      const user = userEvent.setup();
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
      const confirm = await screen.findByRole('button', { name: 'Confirm and start' });
      expect(onConfirm).not.toHaveBeenCalled();
      await user.click(confirm);
      expect(onConfirm).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          canonicalPath: workingDir,
          state: 'non-empty-directory',
        })
      );
      expect(await fs.readdir(workingDir)).toEqual(['preserve.txt']);
      expect(await fs.readFile(sentinel, 'utf8')).toBe('existing project\n');
    } finally {
      await fs.rm(fixture, { recursive: true, force: true });
    }
  });

  it('rechecks a restored directory without loading or confirming until explicitly selected', async () => {
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
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Confirm and start' })).toBeVisible();
    expect(inspectWorkspace).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirm and start' }));
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(candidate);
  });

  it.each([request.workingDir, '/Users/dev/Projects/Ledger', '/Users/dev/中文 项目 (保留)'])(
    'shows the existing confirmation card for the exact persisted workspace %s',
    async (workingDir) => {
      const request = { sessionId: 'session-1', workingDir };
      const candidate = {
        requestedPath: workingDir,
        normalizedPath: workingDir,
        normalizedIdentity: normalizeWorkspaceIdentity(workingDir),
        canonicalPath: workingDir,
        source: 'selected' as const,
        state: 'non-empty-directory' as const,
        isGitRepository: false,
        displayName: 'Ledger',
        suggestedProjectId: 'ledger',
        error: null,
      };
      const user = userEvent.setup();
      const onConfirm = vi.fn();
      const inspectWorkspace = vi.fn().mockResolvedValue([candidate]);

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

      expect(await screen.findByText(request.workingDir)).toBeVisible();
      expect(inspectWorkspace).toHaveBeenCalledWith({
        prompt: `Resume the existing project at "${request.workingDir}"`,
        selectedWorkingDir: request.workingDir,
      });

      expect(onConfirm).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'Confirm and start' }));
      expect(onConfirm).toHaveBeenCalledExactlyOnceWith(candidate);
    }
  );

  it.each([
    [request.workingDir, 'D:\\Changed\\Ledger'],
    ['/Users/dev/Projects/Ledger', '/Users/dev/Projects/ledger'],
  ])('rejects changed canonical identity %s -> %s', async (workingDir, different) => {
    const request = { sessionId: 'session-1', workingDir };
    const onConfirm = vi.fn();
    const changedCandidate = {
      ...candidate,
      normalizedPath: different,
      normalizedIdentity: normalizeWorkspaceIdentity(different),
      canonicalPath: different,
    };

    render(
      <CodeProWorkspaceReconfirmation
        request={request}
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
    expect(screen.queryByRole('button', { name: 'Confirm and start' })).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('keeps inspection failures actionable and lets the user cancel without confirming', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();

    render(
      <CodeProWorkspaceReconfirmation
        request={request}
        confirming={false}
        error={null}
        onConfirm={vi.fn()}
        onCancel={onCancel}
        inspectWorkspace={vi.fn().mockRejectedValue(new Error('workspace unavailable'))}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The persisted workspace is unavailable.'
    );
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(onCancel).toHaveBeenCalledOnce());
  });
});
