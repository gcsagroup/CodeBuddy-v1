import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { ProjectCreator } from './ProjectCreator';
import { ProjectFolderSummary } from './ProjectFolderSummary';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../acp/acpConnection', () => ({ getAcpControlClient: async () => ({ extMethod: rpc }) }));
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  rpc.mockResolvedValue({ version: '', folders: [] });
  window.electron.directoryChooser = vi.fn().mockResolvedValue({ canceled: false, filePaths: ['D:/main', 'D:/upstream', 'd:/MAIN'] });
  window.electron.addRecentDir = vi.fn();
});
it('creates a named multi-folder workspace, deduplicates paths, switches primary and preserves access notes', async () => {
  const created = vi.fn(), close = vi.fn();
  render(<ProjectCreator onCreated={created} onClose={close} />, { wrapper: IntlTestWrapper });
  await userEvent.click(screen.getByRole('button', { name: 'Add folder' }));
  expect(window.electron.directoryChooser).toHaveBeenCalledWith(true);
  expect(screen.getAllByRole('button', { name: 'Make primary' })).toHaveLength(1);
  await userEvent.click(screen.getByRole('button', { name: 'Make primary' }));
  expect(screen.getByRole('textbox', { name: 'Project name' })).toHaveValue('upstream');
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'D:/main' }), 'reference');
  await userEvent.type(screen.getByRole('textbox', { name: /Optional note.*D:\/main/ }), 'API reference');
  expect(screen.getByText(/Full access is unavailable/)).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Create workspace' }));
  await waitFor(() => expect(created).toHaveBeenCalledWith('D:/upstream'));
  expect(rpc).toHaveBeenCalledWith('_codebuddy/project-folders/save', {
    cwd: 'D:/upstream', version: '', folders: [{ path: 'D:/main', access: 'reference', note: 'API reference' }],
  });
  expect(close).toHaveBeenCalledOnce();
});
it('cancel never saves folder links or invokes the selection callback', async () => {
  const created = vi.fn(), close = vi.fn();
  render(<ProjectCreator onCreated={created} onClose={close} />, { wrapper: IntlTestWrapper });
  await userEvent.click(screen.getByRole('button', { name: 'Add folder' }));
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(rpc).not.toHaveBeenCalled(); expect(created).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
});
it('does not overwrite an already configured workspace', async () => {
  rpc.mockResolvedValue({ version: 'existing', folders: [] });
  render(<ProjectCreator onCreated={vi.fn()} onClose={vi.fn()} />, { wrapper: IntlTestWrapper });
  await userEvent.click(screen.getByRole('button', { name: 'Add folder' }));
  await userEvent.click(screen.getByRole('button', { name: 'Create workspace' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/already has a workspace/);
  expect(rpc.mock.calls.every(([method]) => method.endsWith('/get'))).toBe(true);
});
it('shows all linked folders with access labels and an actionable edit entry', async () => {
  rpc.mockResolvedValue({ version: '1', folders: [{ path: 'D:/upstream', access: 'reference' }, { path: 'D:/api', access: 'write' }] });
  const edit = vi.fn();
  render(<ProjectFolderSummary cwd="D:/main" onEdit={edit} />, { wrapper: IntlTestWrapper });
  expect(await screen.findByText('D:/upstream')).toBeVisible();
  expect(screen.getByText('D:/api')).toBeVisible();
  expect(within(screen.getByText('D:/main').parentElement!).getByText('Primary folder')).toBeVisible();
  expect(screen.getByText('Reference only')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Edit project' }));
  expect(edit).toHaveBeenCalledOnce();
});
