import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { ModelInventoryNotice, parseInventoryNotices } from './ModelInventoryNotice';
const rpc = vi.hoisted(() => vi.fn().mockResolvedValue({}));
vi.mock('../acp/acpConnection', () => ({ getAcpControlClient: async () => ({ extMethod: rpc }) }));

it('explains removal and changed capabilities without switching the selected model', async () => {
  rpc.mockClear();
  const refresh = vi.fn().mockResolvedValue(undefined);
  render(<ModelInventoryNotice refresh={refresh} notices={[{ providerId: 'p', providerName: 'Lab', noticeId: 'n', changes: [
    { kind: 'removed', model: 'old-model' }, { kind: 'capabilities', model: 'same-name', fields: ['context', 'thinking'] },
  ] }]} />, { wrapper: IntlTestWrapper });
  expect(screen.getByRole('alert')).toHaveTextContent('Your selected model has not been changed');
  expect(screen.getByRole('alert')).toHaveTextContent('old-model is no longer in the provider model list');
  expect(screen.getByRole('alert')).toHaveTextContent('same-name: the provider changed context capacity, thinking options');
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss changes' }));
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  expect(rpc).toHaveBeenCalledExactlyOnceWith('_goose/unstable/providers/inventory/acknowledge', { providerId: 'p', noticeId: 'n' });
});

it('distinguishes refresh failure from removal and retries only that connection', async () => {
  rpc.mockClear();
  render(<ModelInventoryNotice refresh={async () => {}} notices={[{ providerId: 'offline', providerName: 'Offline', failed: true, changes: [] }]} />, { wrapper: IntlTestWrapper });
  expect(screen.getByRole('alert')).toHaveTextContent('this does not mean its models were removed');
  expect(screen.queryByRole('button', { name: 'Dismiss changes' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh again' }));
  await waitFor(() => expect(rpc).toHaveBeenCalledExactlyOnceWith('_goose/unstable/providers/inventory/refresh', { providerIds: ['offline'] }));
});

it('tolerates old servers and rejects malformed optional notices', () => {
  expect(parseInventoryNotices(undefined)).toEqual([]);
  expect(parseInventoryNotices([{ providerId: 'p', providerName: 'P', changes: [{ kind: 'removed', model: {} }] }])).toEqual([]);
});
