import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../../../../../i18n/test-utils';
import CustomProviderForm from './CustomProviderForm';

describe('provider form validation feedback', () => {
  const scroll = vi.fn();
  const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');

  beforeEach(() => {
    scroll.mockClear();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scroll,
    });
  });

  afterEach(() => {
    if (originalScroll)
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScroll);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  });

  it('locates a missing name without losing the loaded catalog or selected model', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const discoverModels = vi.fn().mockResolvedValue(['alpha', 'beta']);
    render(
      <CustomProviderForm
        initialData={null}
        isEditable
        compactSetup
        discoverModels={discoverModels}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
      { wrapper: IntlTestWrapper }
    );
    await user.click(screen.getByRole('combobox', { name: 'Provider Type' }));
    await user.click(screen.getByRole('option', { name: 'Local Ollama' }));
    await user.click(screen.getByRole('button', { name: 'Load models' }));
    await user.selectOptions(await screen.findByLabelText('Discovered models'), 'beta');
    const name = screen.getByRole('textbox', { name: 'Display Name' });
    await user.clear(name);
    await user.click(screen.getByRole('button', { name: 'Verify and add' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Display name is required');
    await waitFor(() => expect(name).toHaveFocus());
    expect(scroll).toHaveBeenCalledWith({ block: 'center' });
    expect(scroll.mock.instances[scroll.mock.instances.length - 1]).toBe(name);
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAccessibleDescription('Display name is required');
    expect(screen.getByLabelText('Discovered models')).toHaveValue('beta');

    await user.type(name, 'My connection');
    expect(name).toHaveAttribute('aria-invalid', 'false');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Verify and add' }));
    expect(discoverModels).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ display_name: 'My connection', models: ['beta', 'alpha'] }),
      'beta'
    );
  });

  it('moves through missing fields in form order and rejects empty model IDs', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <CustomProviderForm initialData={null} isEditable onSubmit={onSubmit} onCancel={vi.fn()} />,
      { wrapper: IntlTestWrapper }
    );
    await user.click(screen.getByRole('button', { name: /^Configure manually/ }));
    const name = screen.getByRole('textbox', { name: 'Display Name' });
    const url = screen.getByRole('textbox', { name: 'API URL' });
    const models = screen.getByRole('textbox', { name: 'Available Models (comma-separated)' });
    await user.clear(name);
    await user.type(name, '   ');
    await user.type(models, ' , , ');
    await user.click(screen.getByRole('button', { name: 'Verify and add' }));
    await waitFor(() => expect(name).toHaveFocus());
    expect(screen.getByRole('alert')).toHaveTextContent('Display name is required');
    expect(url).toHaveAttribute('aria-invalid', 'true');
    expect(models).toHaveAttribute('aria-invalid', 'true');
    expect(onSubmit).not.toHaveBeenCalled();

    await user.clear(name);
    await user.type(name, 'Manual connection');
    expect(screen.getByRole('alert')).toHaveTextContent('API URL is required');
    await user.click(screen.getByRole('button', { name: 'Verify and add' }));
    await waitFor(() => expect(url).toHaveFocus());
    await user.type(url, 'http://127.0.0.1:11434');
    expect(screen.getByRole('alert')).toHaveTextContent('At least one model is required');
    await user.click(screen.getByRole('button', { name: 'Verify and add' }));
    await waitFor(() => expect(models).toHaveFocus());
    await user.clear(models);
    await user.type(models, 'alpha');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Verify and add' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('focuses a missing key and clears its error when authentication is no longer required', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <CustomProviderForm initialData={null} isEditable onSubmit={onSubmit} onCancel={vi.fn()} />,
      { wrapper: IntlTestWrapper }
    );
    await user.click(screen.getByRole('button', { name: /^Configure manually/ }));
    await user.type(screen.getByRole('textbox', { name: 'Display Name' }), 'Manual connection');
    await user.type(screen.getByRole('textbox', { name: 'API URL' }), 'http://127.0.0.1:11434');
    await user.type(
      screen.getByRole('textbox', { name: 'Available Models (comma-separated)' }),
      'alpha'
    );
    await user.click(screen.getByRole('checkbox', { name: 'This provider requires an API key' }));
    fireEvent.change(screen.getByLabelText(/^API Key/), { target: { value: '   ' } });
    await user.click(screen.getByRole('button', { name: 'Verify and add' }));
    await waitFor(() => expect(screen.getByLabelText(/^API Key/)).toHaveFocus());
    expect(screen.getByRole('alert')).toHaveTextContent('API key is required');
    expect(onSubmit).not.toHaveBeenCalled();
    await user.click(screen.getByRole('checkbox', { name: 'This provider requires an API key' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Verify and add' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
