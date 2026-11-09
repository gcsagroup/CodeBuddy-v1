import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../../../../../i18n/test-utils';
import CustomProviderForm from './CustomProviderForm';

async function chooseLocal(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('combobox', { name: 'Provider Type' }));
  await user.click(screen.getByRole('option', { name: 'Local Ollama' }));
}

describe('CustomProviderForm local connection setup', () => {
  it('sets the official OpenAI agent route to Responses and leaves compatible APIs configurable', async () => {
    const user = userEvent.setup();
    render(
      <CustomProviderForm initialData={null} isEditable compactSetup
        discoverModels={vi.fn()} onSubmit={vi.fn()} onCancel={vi.fn()} />,
      { wrapper: IntlTestWrapper }
    );
    await user.click(screen.getByRole('combobox', { name: 'Provider Type' }));
    await user.click(screen.getByRole('option', { name: 'OpenAI' }));
    expect(screen.getByRole('textbox', { name: 'API URL' })).toHaveValue('https://api.openai.com');
    expect(screen.getByRole('textbox', { name: 'API Base Path (optional)' })).toHaveValue('/v1/responses');
    await user.click(screen.getByRole('combobox', { name: 'Provider Type' }));
    await user.click(screen.getByRole('option', { name: 'OpenAI-compatible API' }));
    expect(screen.getByRole('textbox', { name: 'API Base Path (optional)' })).toHaveValue('');
  });

  it('keeps the catalog after a selected model fails and allows saving another model', async () => {
    const user = userEvent.setup();
    const discoverModels = vi.fn().mockResolvedValue(['gemini-3.6-flash', 'ollama-dev']);
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce({ message: 'Validation failed', data: { code: 'custom_provider_model_unavailable' } })
      .mockResolvedValueOnce(undefined);
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
    await chooseLocal(user);
    await user.click(screen.getByRole('button', { name: 'Load models' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Model list loaded. Select a model, then verify the connection before adding it.'
    );
    await user.click(screen.getByRole('button', { name: 'Verify and add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not complete a test request');
    await user.selectOptions(screen.getByLabelText('Discovered models'), 'ollama-dev');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Verify and add' }));
    expect(discoverModels).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ models: ['gemini-3.6-flash', 'ollama-dev'] }),
      'gemini-3.6-flash'
    );
    expect(onSubmit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ models: ['ollama-dev', 'gemini-3.6-flash'] }),
      'ollama-dev'
    );
  });

  it('offers popular OpenAI-compatible provider presets', async () => {
    const user = userEvent.setup();
    render(
      <CustomProviderForm
        initialData={null}
        isEditable
        compactSetup
        discoverModels={vi.fn()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(screen.getByText('OpenAI-compatible API')).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: 'Provider Type' }));
    expect(await screen.findByText('DeepSeek')).toBeInTheDocument();
    expect(screen.getByText('SiliconFlow')).toBeInTheDocument();
    expect(screen.getByText('Kimi / Moonshot')).toBeInTheDocument();
    expect(screen.getByText('Zhipu AI')).toBeInTheDocument();
    expect(screen.getByText('Alibaba Cloud Model Studio')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'OpenAI-compatible API' })).toBeInTheDocument();
    expect(screen.getByText('Local Ollama')).toBeInTheDocument();
  });

  it('starts without a URL or key and only discovers a connection the user chooses', async () => {
    const discoverModels = vi.fn().mockResolvedValue(['qwen3-coder', 'deepseek-r1']);
    const user = userEvent.setup();

    render(
      <CustomProviderForm
        initialData={null}
        isEditable
        compactSetup
        discoverModels={discoverModels}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(screen.queryByText('Start from a provider template')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'API URL' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Display Name' })).toHaveValue('Custom connection');
    expect(screen.getByLabelText(/^API Key/)).toHaveValue('');
    expect(discoverModels).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Available Models (comma-separated)')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Verify and add' })).toBeDisabled();

    await chooseLocal(user);
    await user.click(screen.getByRole('button', { name: 'Load models' }));

    expect(discoverModels).toHaveBeenCalledWith(
      expect.objectContaining({
        engine: 'ollama_compatible',
        api_url: 'http://127.0.0.1:11434',
      })
    );
    expect(await screen.findByRole('option', { name: 'qwen3-coder' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'deepseek-r1' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Model list loaded. Select a model, then verify the connection before adding it.'
    );
    expect(screen.getByRole('button', { name: 'Verify and add' })).toBeEnabled();
  });

  it('keeps save disabled and explains a failed connection', async () => {
    const discoverModels = vi.fn().mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();

    render(
      <CustomProviderForm
        initialData={null}
        isEditable
        compactSetup
        discoverModels={discoverModels}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
      { wrapper: IntlTestWrapper }
    );

    await user.type(screen.getByRole('textbox', { name: 'Display Name' }), 'Offline local model');
    await chooseLocal(user);
    await user.click(screen.getByRole('button', { name: 'Load models' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
    expect(screen.queryByLabelText('Model ID')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Verify and add' })).toBeDisabled();
  });

  it('saves the model selected by the user as the primary model', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(
      <CustomProviderForm
        initialData={null}
        isEditable
        compactSetup
        discoverModels={vi.fn().mockResolvedValue(['alpha-model', 'beta-model'])}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
      { wrapper: IntlTestWrapper }
    );

    await user.type(screen.getByRole('textbox', { name: 'Display Name' }), 'My local model');
    await chooseLocal(user);
    await user.click(screen.getByRole('button', { name: 'Load models' }));
    await user.selectOptions(await screen.findByLabelText('Discovered models'), 'beta-model');
    await user.click(screen.getByRole('button', { name: 'Verify and add' }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ models: ['beta-model', 'alpha-model'] }),
      'beta-model'
    );
  });

  it('submits only once while an identical create request is still in flight', async () => {
    let finishSubmit: (() => void) | undefined;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSubmit = resolve;
        })
    );
    const user = userEvent.setup();
    render(
      <CustomProviderForm
        initialData={null}
        isEditable
        compactSetup
        discoverModels={vi.fn().mockResolvedValue(['local-model'])}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
      { wrapper: IntlTestWrapper }
    );

    await user.type(screen.getByRole('textbox', { name: 'Display Name' }), 'My local model');
    await chooseLocal(user);
    await user.click(screen.getByRole('button', { name: 'Load models' }));
    const createButton = screen.getByRole('button', { name: 'Verify and add' });
    const form = createButton.closest('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form!);
    fireEvent.submit(form!);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(createButton).toBeDisabled();
    expect(createButton).toHaveTextContent('Verifying…');
    expect(screen.getByRole('textbox', { name: 'API URL' })).toBeDisabled();
    finishSubmit?.();
  });

  it('keeps an edited local connection on the Ollama engine', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(
      <CustomProviderForm
        initialData={{
          engine: 'ollama_compatible',
          display_name: 'Office local model',
          api_url: 'http://127.0.0.1:11434',
          api_key: '',
          models: ['qwen3:8b'],
          requires_auth: false,
        }}
        isEditable
        compactSetup
        discoverModels={vi.fn().mockResolvedValue(['qwen3:8b'])}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(screen.getByRole('button', { name: 'Verify and save' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Verify and save' }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ engine: 'ollama_compatible' }), 'qwen3:8b');
  });

  it.each([
    { error: { message: 'Validation failed', data: { code: 'custom_provider_invalid_credentials', httpStatus: 401 } }, expected: 'The API key was rejected.', outcome: 'The connection was not saved' },
    { error: new Error('PRIVATE_ECHOED_KEY'), expected: 'Verification result unconfirmed', outcome: 'check the connection list before retrying' },
  ])('shows structured validation evidence and treats missing save receipts as unconfirmed: $expected', async ({ error, expected, outcome }) => {
    const user = userEvent.setup();
    render(
      <CustomProviderForm
        initialData={{
          engine: 'openai_compatible',
          display_name: 'Remote model',
          api_url: 'https://example.invalid',
          api_key: '',
          models: ['remote-model'],
          requires_auth: false,
        }}
        isEditable
        compactSetup
        discoverModels={vi.fn().mockResolvedValue(['remote-model'])}
        onSubmit={vi.fn().mockRejectedValue(error)}
        onCancel={vi.fn()}
      />,
      { wrapper: IntlTestWrapper }
    );

    await user.click(screen.getByRole('button', { name: 'Load models' }));
    await user.click(screen.getByRole('button', { name: 'Verify and save' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(expected);
    expect(alert).toHaveTextContent(outcome);
    expect(alert).not.toHaveTextContent('PRIVATE_ECHOED_KEY');
  });

  it('shows that a random API key was rejected instead of reporting success', async () => {
    const user = userEvent.setup();
    render(
      <CustomProviderForm
        initialData={null}
        isEditable
        compactSetup
        discoverModels={vi.fn().mockRejectedValue({
          message: 'Invalid params',
          data: {
            code: 'custom_provider_invalid_credentials',
            message: 'The API key was rejected.',
          },
        })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
      { wrapper: IntlTestWrapper }
    );

    await user.click(screen.getByRole('combobox', { name: 'Provider Type' }));
    await user.click(screen.getByRole('option', { name: 'OpenAI-compatible API' }));
    expect(screen.getByRole('textbox', { name: 'Display Name' })).toHaveValue('Custom connection');
    await user.type(screen.getByRole('textbox', { name: 'Display Name' }), 'Remote test');
    await user.type(screen.getByRole('textbox', { name: 'API URL' }), 'https://example.test');
    await user.type(screen.getByLabelText(/^API Key/), '12345');
    await user.click(screen.getByRole('button', { name: 'Load models' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The API key was rejected. Check it and try again.'
    );
    expect(screen.getByRole('button', { name: 'Verify and add' })).toBeDisabled();
  });

  it('requires another connection test after the address changes', async () => {
    const user = userEvent.setup();
    render(
      <CustomProviderForm
        initialData={null}
        isEditable
        compactSetup
        discoverModels={vi.fn().mockResolvedValue(['local-model'])}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
      { wrapper: IntlTestWrapper }
    );

    await user.type(screen.getByRole('textbox', { name: 'Display Name' }), 'My local model');
    await chooseLocal(user);
    await user.click(screen.getByRole('button', { name: 'Load models' }));
    expect(screen.getByRole('button', { name: 'Verify and add' })).toBeEnabled();
    await user.type(screen.getByRole('textbox', { name: 'API URL' }), '/changed');
    expect(screen.getByRole('button', { name: 'Verify and add' })).toBeDisabled();
  });

  it('keeps a name the user entered when the provider preset changes', async () => {
    const user = userEvent.setup();
    render(
      <CustomProviderForm
        initialData={null}
        isEditable
        compactSetup
        discoverModels={vi.fn()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
      { wrapper: IntlTestWrapper }
    );

    const displayName = screen.getByRole('textbox', { name: 'Display Name' });
    await chooseLocal(user);
    expect(displayName).toHaveValue('Local Ollama');
    await user.type(displayName, 'temporary name');
    await user.click(screen.getByRole('combobox', { name: 'Provider Type' }));
    await user.click(screen.getByRole('option', { name: 'OpenAI-compatible API' }));
    expect(displayName).toHaveValue('Local Ollamatemporary name');
  });
});
