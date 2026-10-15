import type { ReactElement } from 'react';
import { fireEvent, render as testingRender, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RootCleanupAudit } from '../../acp/rootCleanup';
import {
  parseRootCleanupRequiredEvent,
  RootCleanupPrompt,
  RootCleanupInline,
  RootCleanupRecoveryPanel,
} from './RootCleanupInline';
import { IntlTestWrapper } from '../../i18n/test-utils';

const render = (ui: ReactElement) => testingRender(ui, { wrapper: IntlTestWrapper });

const audit: RootCleanupAudit = {
  auditToken: 'audit-1',
  rootIdentity: 'd:',
  target: {
    relativePath: 'fixture\\remove.tmp',
    targetType: 'file',
    bytes: 7,
    modifiedMillis: 1,
    hash: 'abc',
  },
  destructiveConfirmationRequired: true,
};

describe('RootCleanupPrompt', () => {
  it('rejects events without a backend-issued message capability', () => {
    expect(
      parseRootCleanupRequiredEvent({
        event: 'codepro.cleanup_audit_required',
        rootContainerPath: 'D:\\',
        writableRoot: null,
        writeCount: 0,
      })
    ).toBeNull();
  });

  it('performs no delete before a separate exact-target confirmation', async () => {
    const quarantine = {
      quarantineToken: 'quarantine-1',
      target: audit.target,
      permanentConfirmationRequired: true as const,
    };
    const execute = vi.fn().mockResolvedValue(quarantine);
    const permanentlyDelete = vi.fn().mockResolvedValue(undefined);
    render(
      <RootCleanupPrompt
        rootPath="D:\\"
        selectAndAudit={vi.fn().mockResolvedValue(audit)}
        execute={execute}
        permanentlyDelete={permanentlyDelete}
        restore={vi.fn()}
        cancel={vi.fn()}
      />
    );
    expect(execute).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Select exact target/ }));
    await screen.findByText(audit.target.relativePath);
    expect(execute).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Confirm quarantine move/ }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith('audit-1'));
    expect(permanentlyDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Confirm permanent deletion/ }));
    await waitFor(() => expect(permanentlyDelete).toHaveBeenCalledWith('quarantine-1'));
    expect(screen.getByText('Exact cleanup completed.')).toBeInTheDocument();
  });

  it('cancels an audit token without executing deletion', async () => {
    const execute = vi.fn();
    const cancel = vi.fn().mockResolvedValue(undefined);
    render(
      <RootCleanupPrompt
        rootPath="D:\\"
        selectAndAudit={vi.fn().mockResolvedValue(audit)}
        execute={execute}
        permanentlyDelete={vi.fn()}
        restore={vi.fn()}
        cancel={cancel}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Select exact target/ }));
    await screen.findByText(audit.target.relativePath);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith('audit-1'));
    expect(execute).not.toHaveBeenCalled();
  });

  it('restores a quarantined target without permanent deletion', async () => {
    const execute = vi.fn().mockResolvedValue({
      quarantineToken: 'quarantine-1',
      target: audit.target,
      permanentConfirmationRequired: true,
    });
    const restore = vi.fn().mockResolvedValue(undefined);
    const permanentlyDelete = vi.fn();
    render(
      <RootCleanupPrompt
        rootPath="D:\\"
        selectAndAudit={vi.fn().mockResolvedValue(audit)}
        execute={execute}
        permanentlyDelete={permanentlyDelete}
        restore={restore}
        cancel={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Select exact target/ }));
    await screen.findByText(audit.target.relativePath);
    fireEvent.click(screen.getByRole('button', { name: /Confirm quarantine move/ }));
    await screen.findByRole('button', { name: /Restore quarantined target/ });
    fireEvent.click(screen.getByRole('button', { name: /Restore quarantined target/ }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith('quarantine-1'));
    expect(permanentlyDelete).not.toHaveBeenCalled();
  });

  it('resets to a fresh audit when an expired quarantine was safely restored', async () => {
    const execute = vi.fn().mockResolvedValue({
      quarantineToken: 'quarantine-expired',
      target: audit.target,
      permanentConfirmationRequired: true,
    });
    render(
      <RootCleanupPrompt
        rootPath="D:\\"
        selectAndAudit={vi.fn().mockResolvedValue(audit)}
        execute={execute}
        permanentlyDelete={vi.fn().mockRejectedValue(new Error('token is missing or expired'))}
        restore={vi.fn()}
        cancel={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Select exact target/ }));
    await screen.findByText(audit.target.relativePath);
    fireEvent.click(screen.getByRole('button', { name: /Confirm quarantine move/ }));
    await screen.findByRole('button', { name: /Confirm permanent deletion/ });
    fireEvent.click(screen.getByRole('button', { name: /Confirm permanent deletion/ }));

    expect(
      await screen.findByText(
        'Cleanup authorization expired or was safely restored. Select and audit again.'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Select exact target/ })).toBeInTheDocument();
  });

  it('lists only backend-authorized recoveries and disables retry when unavailable', async () => {
    const capability = {
      sessionId: 'session-1',
      runId: 'run-1',
      sourceMessageId: 'message-1',
      nonce: 'nonce-1',
    };
    const recovery = {
      quarantineToken: 'quarantine-1',
      phase: 'orphan',
      originalPath: 'D:\\cache\\fixture.tmp',
      quarantinePath: 'D:\\cache\\.codebuddy-quarantine-quarantine-1\\target',
      retryOriginalAvailable: false,
    };
    const list = vi.fn().mockResolvedValue([recovery]);
    const retry = vi.fn();
    render(<RootCleanupRecoveryPanel capability={capability} list={list} retry={retry} />);
    fireEvent.click(screen.getByRole('button', { name: /Check recoverable/ }));
    expect(await screen.findByText(/orphan: D:/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry original/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Reveal recoverable/ })).not.toBeInTheDocument();
    expect(retry).not.toHaveBeenCalled();
  });

  it('reports list failures and coalesces repeated refresh clicks', async () => {
    const capability = {
      sessionId: 'session-1',
      runId: 'run-1',
      sourceMessageId: 'message-1',
      nonce: 'nonce-1',
    };
    let rejectList: (reason: Error) => void = () => undefined;
    const list = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectList = reject;
        })
    );
    render(<RootCleanupRecoveryPanel capability={capability} list={list} />);
    const refresh = screen.getByRole('button', { name: /Check recoverable/ });
    fireEvent.click(refresh);
    fireEvent.click(refresh);
    expect(list).toHaveBeenCalledTimes(1);
    rejectList(new Error('journal unavailable'));
    expect(await screen.findByRole('alert')).toHaveTextContent('journal unavailable');
  });
});

describe('Mac read-only cleanup UI', () => {
  it('shows the exact summary and cancel without quarantine or delete controls', async () => {
    const execute = vi.fn();
    const permanentlyDelete = vi.fn();
    const cancel = vi.fn().mockResolvedValue(undefined);
    render(
      <RootCleanupPrompt
        rootPath="/"
        selectAndAudit={vi.fn().mockResolvedValue({ ...audit, executionAvailable: false })}
        execute={execute}
        permanentlyDelete={permanentlyDelete}
        restore={vi.fn()}
        cancel={cancel}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Select exact target/ }));
    await screen.findByText(audit.target.relativePath);
    expect(screen.getByText(/Read-only audit/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Confirm/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/first confirmation only moves/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith('audit-1'));
    await screen.findByRole('button', { name: /Select exact target/ });
    expect(execute).not.toHaveBeenCalled();
    expect(permanentlyDelete).not.toHaveBeenCalled();
  });
  it('uses the backend event capability to hide recovery before any audit', () => {
    const data = {
      event: 'codepro.cleanup_audit_required',
      rootContainerPath: '/',
      writableRoot: null,
      writeCount: 0,
      executionAvailable: false,
      capability: { sessionId: 's', runId: 'r', sourceMessageId: 'm', nonce: 'n' },
    };
    expect(parseRootCleanupRequiredEvent({ ...data, executionAvailable: 'false' })).toBeNull();
    render(
      <RootCleanupInline
        notification={
          { type: 'systemNotification', notificationType: 'inlineMessage', msg: '', data } as never
        }
      />
    );
    expect(screen.getByText(/Read-only audit/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Check recoverable/ })).not.toBeInTheDocument();
  });
});

it('requires a new message after a read-only authorization expires', async () => {
  render(
    <RootCleanupPrompt
      rootPath="/"
      executionAvailable={false}
      selectAndAudit={vi.fn().mockRejectedValue(new Error('root capability is expired'))}
      execute={vi.fn()}
      permanentlyDelete={vi.fn()}
      restore={vi.fn()}
      cancel={vi.fn()}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: /Select exact target/ }));
  await screen.findByText(/Send a new cleanup audit request/);
  expect(screen.getByRole('button', { name: /Select exact target/ })).toBeDisabled();
});
