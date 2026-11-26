import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Model connection notifications' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Your model selection is unchanged');
  fireEvent.click(screen.getByRole('button', { name: 'View details' }));
  expect(screen.getByText(/old-model is no longer/)).toBeTruthy();
  expect(screen.getByText(/same-name: the provider changed context capacity, thinking options/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss changes' }));
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  expect(rpc).toHaveBeenCalledExactlyOnceWith('_goose/unstable/providers/inventory/acknowledge', { providerId: 'p', noticeId: 'n' });
});

it('distinguishes refresh failure from removal and retries only that connection', async () => {
  rpc.mockClear();
  render(<ModelInventoryNotice refresh={async () => {}} notices={[{ providerId: 'offline', providerName: 'Offline', failed: true, changes: [] }]} />, { wrapper: IntlTestWrapper });
  fireEvent.click(screen.getByRole('button', { name: 'Model connection notifications' }));
  expect(screen.getByRole('status')).toHaveTextContent('This does not mean models were removed');
  fireEvent.click(screen.getByRole('button', { name: 'View details' }));
  expect(screen.queryByRole('button', { name: 'Dismiss changes' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh again' }));
  await waitFor(() => expect(rpc).toHaveBeenCalledExactlyOnceWith('_goose/unstable/providers/inventory/refresh', { providerIds: ['offline'] }));
});

it('tolerates old servers and rejects malformed optional notices', () => {
  expect(parseInventoryNotices(undefined)).toEqual([]);
  expect(parseInventoryNotices([{ providerId: 'p', providerName: 'P', changes: [{ kind: 'removed', model: {} }] }])).toEqual([]);
});

it('previews new messages for five seconds without resetting on polling, and keeps details in the bell', () => {
  vi.useFakeTimers();
  try {
    const notice = { providerId: 'p', providerName: 'Lab', failed: true, httpStatus: 503, changes: [] };
    const props = { refresh: async () => {}, notices: [notice] };
    const view = render(<ModelInventoryNotice {...props} />, { wrapper: IntlTestWrapper });
    expect(screen.getByRole('region', { name: 'New model connection notifications' })).toHaveTextContent('Refresh failed');
    act(() => vi.advanceTimersByTime(3000));
    view.rerender(<ModelInventoryNotice {...props} notices={[{ ...notice, loading: true }]} />);
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.queryByRole('region', { name: 'New model connection notifications' })).toBeNull();
    view.rerender(<ModelInventoryNotice {...props} notices={[{ ...notice }]} />);
    expect(screen.queryByRole('region', { name: 'New model connection notifications' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Model connection notifications' }));
    fireEvent.click(screen.getByRole('button', { name: 'View details' }));
    expect(screen.getByText(/HTTP 503/)).toBeTruthy();
    act(() => vi.advanceTimersByTime(10000));
    expect(screen.getByText(/HTTP 503/)).toBeTruthy();
  } finally { vi.useRealTimers(); }
});

it('pauses a preview while reading, opens details directly and announces a recovered connection failing again', () => {
  vi.useFakeTimers();
  try {
    const notice = { providerId: 'p', providerName: 'Lab', failed: true, httpStatus: 401, changes: [] };
    const props = { refresh: async () => {}, notices: [notice] };
    const view = render(<ModelInventoryNotice {...props} />, { wrapper: IntlTestWrapper });
    const preview = screen.getByRole('region', { name: 'New model connection notifications' });
    fireEvent.mouseEnter(preview);
    act(() => vi.advanceTimersByTime(10000));
    expect(preview).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View details' }));
    expect(screen.queryByRole('region', { name: 'New model connection notifications' })).toBeNull();
    expect(screen.getByText(/HTTP 401/)).toBeTruthy();
    view.rerender(<ModelInventoryNotice {...props} notices={[]} />);
    view.rerender(<ModelInventoryNotice {...props} />);
    expect(screen.getByRole('region', { name: 'New model connection notifications' })).toBeTruthy();
  } finally { vi.useRealTimers(); }
});

it('shows the specific HTTP failure and dismisses when clicking elsewhere', () => {
  render(<ModelInventoryNotice refresh={async () => {}} notices={[{ providerId: 'p', providerName: 'Lab', failed: true, httpStatus: 401, changes: [] }]} />, { wrapper: IntlTestWrapper });
  fireEvent.click(screen.getByRole('button', { name: 'Model connection notifications' }));
  fireEvent.click(screen.getByRole('button', { name: 'View details' }));
  expect(screen.getByText(/HTTP 401/)).toHaveTextContent('API key was rejected');
  fireEvent.pointerDown(document.body);
  expect(screen.queryByText(/HTTP 401/)).toBeNull();
});

it('keeps loading and retry feedback in the same notification center', async () => {
  const view = render(<ModelInventoryNotice refresh={async () => {}} notices={[{ providerId: 'p', providerName: 'Lab', loading: true, changes: [] }]} />, { wrapper: IntlTestWrapper });
  expect(screen.queryByRole('status')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Model connection notifications' }));
  expect(screen.getByRole('status')).toHaveTextContent('Refreshing model connections');
  fireEvent.click(screen.getByRole('button', { name: 'Hide for now' }));
  expect(screen.queryByRole('status')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Model connection notifications' }));
  expect(screen.getByRole('status')).toHaveTextContent('Refreshing');
  view.rerender(<ModelInventoryNotice refresh={async () => {}} notices={[]} />);
  expect(screen.queryByRole('button', { name: 'Model connection notifications' })).toBeNull();
});

it('stays collapsed across polling and new changes without acknowledging', () => {
  rpc.mockClear();
  const notice = { providerId: 'p', providerName: 'Lab', failed: true, changes: [] };
  const props = { refresh: async () => {}, notices: [notice] };
  const view = render(<ModelInventoryNotice {...props} />, { wrapper: IntlTestWrapper });
  fireEvent.click(screen.getByRole('button', { name: 'Model connection notifications' }));
  fireEvent.click(screen.getByRole('button', { name: 'Hide for now' }));
  expect(screen.queryByRole('status')).toBeNull();
  view.rerender(<ModelInventoryNotice {...props} notices={[{ ...notice }]} />);
  expect(screen.queryByRole('status')).toBeNull();
  expect(rpc).not.toHaveBeenCalled();
  view.rerender(<ModelInventoryNotice {...props} notices={[{ ...notice, noticeId: 'new', changes: [{ kind: 'removed', model: 'old' }] }]} />);
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Model connection notifications' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Some models are no longer listed');
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('alert')).toBeNull();
});

it('keeps keyboard-focused previews open after mouse leave and dismisses with Escape', () => {
  vi.useFakeTimers();
  try {
    render(<ModelInventoryNotice refresh={async () => {}} notices={[{ providerId: 'p', providerName: 'Lab', failed: true, changes: [] }]} />, { wrapper: IntlTestWrapper });
    const preview = screen.getByRole('region', { name: 'New model connection notifications' });
    const details = screen.getByRole('button', { name: 'View details' });
    fireEvent.mouseEnter(preview);
    act(() => details.focus());
    fireEvent.mouseLeave(preview);
    act(() => vi.advanceTimersByTime(10000));
    expect(preview).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(preview).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Model connection notifications' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Model connection notifications' }));
    expect(screen.getByRole('status')).toHaveTextContent('Keeping the saved model list');
  } finally { vi.useRealTimers(); }
});

it('refreshes diagnostics after a rejected retry and scopes feedback to that connection', async () => {
  let rejectRetry!: (error: Error) => void;
  rpc.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRetry = reject; }));
  const refresh = vi.fn().mockResolvedValue(undefined);
  render(<ModelInventoryNotice refresh={refresh} notices={[
    { providerId: 'p', providerName: 'First', failed: true, changes: [] },
    { providerId: 'q', providerName: 'Second', failed: true, changes: [] },
  ]} />, { wrapper: IntlTestWrapper });
  fireEvent.click(screen.getByRole('button', { name: 'Model connection notifications' }));
  fireEvent.click(screen.getByRole('button', { name: 'View details' }));
  const buttons = screen.getAllByRole('button', { name: 'Refresh again' });
  fireEvent.click(buttons[0]);
  await waitFor(() => expect(rejectRetry).toBeTypeOf('function'));
  expect(buttons[0]).toBeDisabled();
  expect(buttons[1]).not.toBeDisabled();
  await act(async () => rejectRetry(new Error('refused')));
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('alert')).toHaveTextContent('Retry failed');
  expect(screen.getByRole('alert').parentElement).toHaveTextContent('First');
  expect(screen.getByRole('alert').parentElement).not.toHaveTextContent('Second');
  fireEvent.click(buttons[0]);
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  expect(screen.getByText(/Refresh completed/)).toBeInTheDocument();
});
