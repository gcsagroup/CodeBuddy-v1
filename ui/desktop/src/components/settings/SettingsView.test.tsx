import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SettingsView from './SettingsView';

vi.mock('../../i18n', () => ({
  defineMessages: <T,>(messages: T) => messages,
  useIntl: () => ({
    formatMessage: (message: { defaultMessage: string }) => message.defaultMessage,
  }),
}));

vi.mock('./models/ModelsAndRuntimeSettings', () => ({
  default: () => <div data-testid="models-and-runtime">model-connections</div>,
}));

vi.mock('./chat/ChatSettingsSection', () => ({ default: () => <div>behavior-settings</div> }));
vi.mock('./app/ExternalBackendSection', () => ({ default: () => <div>connection-settings</div> }));
vi.mock('./app/AppSettingsSection', () => ({ default: () => <div>general-settings</div> }));
vi.mock('./PromptsSettingsSection', () => ({ default: () => <div>prompt-settings</div> }));
vi.mock('./keyboard/KeyboardShortcutsSection', () => ({
  default: () => <div>keyboard-settings</div>,
}));
vi.mock('./auth/AuthSettingsSection', () => ({ default: () => <div>auth-settings</div> }));
vi.mock('./memory/MemorySettingsSection', () => ({ default: () => <div>memory-settings</div> }));

describe('SettingsView', () => {
  it('opens as a centered dialog and closes from its close button', () => {
    const onClose = vi.fn();
    render(<SettingsView onClose={onClose} setView={vi.fn()} viewOptions={{}} />);

    expect(screen.getByTestId('settings-dialog')).toHaveClass('!max-w-none');
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toHaveClass('bg-black/25');

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders the grouped settings navigation instead of the legacy horizontal tabs', () => {
    render(<SettingsView onClose={vi.fn()} setView={vi.fn()} viewOptions={{}} />);

    expect(screen.getByTestId('settings-navigation')).toBeInTheDocument();
    expect(screen.getByText('Common')).toBeInTheDocument();
    expect(screen.getByText('AI')).toBeInTheDocument();
    expect(screen.getByText('Connections and security')).toBeInTheDocument();
    expect(screen.queryByText('Advanced')).not.toBeInTheDocument();
    expect(screen.queryByTestId('settings-models-tab')).not.toBeInTheDocument();
  });

  it('shows model connections without depending on the bundled GGUF runtime', () => {
    render(<SettingsView onClose={vi.fn()} setView={vi.fn()} viewOptions={{}} />);

    expect(screen.getByTestId('models-and-runtime')).toHaveTextContent('model-connections');
  });

  it('searches settings destinations and opens the matching page', () => {
    render(<SettingsView onClose={vi.fn()} setView={vi.fn()} viewOptions={{}} />);

    fireEvent.change(screen.getByTestId('settings-search'), { target: { value: 'endpoint' } });
    expect(screen.getByTestId('settings-nav-models')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-nav-memory')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('settings-nav-models'));
    expect(screen.getByTestId('models-and-runtime')).toBeInTheDocument();
  });

  it('maps legacy deep links into the new information architecture', () => {
    render(
      <SettingsView onClose={vi.fn()} setView={vi.fn()} viewOptions={{ section: 'memory' }} />
    );

    expect(screen.getByTestId('settings-nav-memory')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('memory-settings')).toBeInTheDocument();
  });

  it('keeps the raw configuration editor out of general settings', () => {
    render(<SettingsView onClose={vi.fn()} setView={vi.fn()} viewOptions={{}} />);

    fireEvent.click(screen.getByTestId('settings-nav-app'));

    expect(screen.getByText('general-settings')).toBeInTheDocument();
    expect(screen.queryByText('Configuration Editor')).not.toBeInTheDocument();
  });
});
