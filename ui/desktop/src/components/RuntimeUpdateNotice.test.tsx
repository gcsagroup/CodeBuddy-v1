import { act, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { RuntimeUpdateNotice } from './RuntimeUpdateNotice';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../acp/acpConnection', () => ({ getAcpControlClient: async () => ({ extMethod: rpc }) }));

it('only shows confirmed stale source, refreshes on focus and never restarts a task', async () => {
  rpc.mockResolvedValueOnce({ restartRequired: false }).mockResolvedValueOnce({ restartRequired: true, activeTurns: 1 }).mockResolvedValue({ restartRequired: false });
  render(<RuntimeUpdateNotice />, { wrapper: IntlTestWrapper });
  await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('status')).toBeNull();
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  expect(screen.getByRole('status')).toBeTruthy();
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  expect(screen.queryByRole('status')).toBeNull();
  expect(rpc.mock.calls.every(([method]) => method === '_goose/unstable/runtime/status')).toBe(true);
});

it('does not label a connection failure as outdated source', async () => {
  rpc.mockReset().mockRejectedValue(new Error('Disconnected'));
  render(<RuntimeUpdateNotice />, { wrapper: IntlTestWrapper });
  await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('status')).toBeNull();
});

it('identifies an older backend by its structured unsupported-method response', async () => {
  rpc.mockReset().mockRejectedValue(Object.assign(new Error('Method not found'), { code: -32601 }));
  render(<RuntimeUpdateNotice />, { wrapper: IntlTestWrapper });
  await screen.findByRole('status');
});
