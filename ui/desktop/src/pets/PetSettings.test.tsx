import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PetSettings from './PetSettings';
import type { PetSnapshot } from './petTypes';
vi.mock('./PetSprite', () => ({ PetSprite: () => <span>sprite</span> }));
vi.mock('../i18n', () => ({ currentLocale: 'en' }));
const snapshot: PetSnapshot = {
  preferences: { visible: false, selectedId: 'red-panda', size: 160, reducedMotion: false },
  pets: ['red-panda', 'cream-cat', 'white-fox'].map((id) => ({
    schemaVersion: 1,
    id,
    name: id,
    description: 'Hello',
    image: 'sprites.png',
    columns: 6,
    rows: 8,
    cellWidth: 192,
    cellHeight: 208,
    fps: 6,
    hash: 'x',
    imageUrl: '',
    builtin: true,
  })),
  errors: [],
  creationDirectory: 'test/custom',
  task: null,
};
describe('pet settings', () => {
  const request = vi.fn(async () => snapshot);
  beforeEach(() => {
    request.mockClear();
    Object.assign(window, { electron: { desktopPet: request, on: vi.fn(), off: vi.fn() } });
  });
  it('offers all three companions and separates preview, selection and visibility', async () => {
    render(<PetSettings />);
    await screen.findByText('My pets');
    expect(screen.getAllByRole('article')).toHaveLength(3);
    const panda = screen.getByRole('button', { name: 'Preview red-panda' }).closest('article')!;
    expect(within(panda).getByText('Selected')).toBeDisabled();
    expect(within(panda).getByText('Default companion')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Preview white-fox' }));
    expect(request).toHaveBeenCalledTimes(1);
    const fox = screen.getByRole('button', { name: 'Preview white-fox' }).closest('article')!;
    fireEvent.click(within(fox).getByText('Set as desktop pet'));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        action: 'configure',
        preferences: { selectedId: 'white-fox', visible: true },
      })
    );
    expect(request).not.toHaveBeenCalledWith({
      action: 'configure',
      preferences: { visible: true },
    });
  });
  it('shows the default preview, toggles visibility separately, refreshes and opens real creation', async () => {
    render(<PetSettings />);
    await screen.findByText('My pets');
    fireEvent.click(screen.getByText('Show pet'));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({ action: 'configure', preferences: { visible: true } })
    );
    await waitFor(() => expect(screen.getByText('Refresh')).not.toBeDisabled());
    fireEvent.click(screen.getByText('Refresh'));
    await waitFor(() => expect(request).toHaveBeenCalledWith({ action: 'refresh' }));
    await waitFor(() => expect(screen.getByText('Create a pet')).not.toBeDisabled());
    fireEvent.click(screen.getByText('Create a pet'));
    await waitFor(() => expect(request).toHaveBeenCalledWith({ action: 'create' }));
  });
});
