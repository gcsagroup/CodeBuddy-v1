import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, type RenderOptions, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ExtensionModal from './ExtensionModal';
import { ExtensionFormData, extensionToFormData, createExtensionConfig } from '../utils';
import { IntlTestWrapper } from '../../../../i18n/test-utils';
import { acpReadConfig, acpUpsertConfig } from '../../../../acp/config';

vi.mock('../../../../acp/config', async () => {
  const actual =
    await vi.importActual<typeof import('../../../../acp/config')>('../../../../acp/config');
  return {
    ...actual,
    acpReadConfig: vi.fn().mockResolvedValue({ maskedValue: '••••••••' }),
    acpUpsertConfig: vi.fn().mockResolvedValue(undefined),
  };
});

const mockedUpsertConfig = vi.mocked(acpUpsertConfig);
const mockedReadConfig = vi.mocked(acpReadConfig);

const renderWithIntl = (ui: React.ReactElement, options?: RenderOptions) =>
  render(ui, { wrapper: IntlTestWrapper, ...options });

describe('ExtensionModal', () => {
  it.each(['stdio', 'streamable_http'] as const)('can test an existing %s extension with an omitted timeout', async type => {
    const user = userEvent.setup();
    const onTest = vi.fn().mockResolvedValue({ success: true, latencyMs: 10, tools: ['probe'], resourceCount: 0, supportsResources: false });
    const extension = type === 'stdio'
      ? { type, name: 'legacy', enabled: true, description: '', cmd: 'python', args: [] }
      : { type, name: 'legacy', enabled: true, description: '', uri: 'http://localhost:1234/mcp', headers: {} };
    renderWithIntl(<ExtensionModal title="Edit" initialData={extensionToFormData(extension)} onClose={vi.fn()} onSubmit={vi.fn()} onTest={onTest} submitLabel="Save" modalType="edit" />);
    expect(screen.getByDisplayValue('300')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(onTest).toHaveBeenCalledWith(expect.objectContaining({ timeout: 300 })));
    expect(await screen.findByRole('status')).toHaveTextContent('1 tools');
  });

  it('keeps an explicitly invalid timeout invalid instead of replacing it with the default', () => {
    renderWithIntl(<ExtensionModal title="Edit" initialData={extensionToFormData({ type: 'stdio', name: 'invalid', enabled: true, description: '', cmd: 'python', args: [], timeout: 0 })} onClose={vi.fn()} onSubmit={vi.fn()} onTest={vi.fn()} submitLabel="Save" modalType="edit" />);
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
  });

  beforeEach(() => {
    mockedReadConfig.mockReset();
    mockedReadConfig.mockResolvedValue({ maskedValue: '••••••••' });
  });

  it('preserves Mac command and literal args when saving a description edit', async () => {
    const originalElectron = window.electron;
    window.electron = { ...originalElectron, platform: 'darwin' };
    try {
      const extension = {
        type: 'stdio' as const,
        name: 'Mac literal paths',
        timeout: 300,
        enabled: false,
        description: 'old description',
        cmd: "/Applications/O'Brien Tools/bin/node",
        args: ['/tmp/中文 $HOME/server.js', '', 'a"b\'c', 'literal\\path', '#literal'],
      };
      const saved = vi.fn();
      const onSubmit = (form: ExtensionFormData) => {
        saved(createExtensionConfig(form));
      };
      renderWithIntl(
        <ExtensionModal
          title="Edit Mac extension"
          initialData={extensionToFormData(extension)}
          onClose={vi.fn()}
          onSubmit={onSubmit}
          submitLabel="Save"
          modalType="edit"
        />
      );
      expect(screen.getByText(/Conversations following the toolbox apply changes/)).toBeVisible();
      const user = userEvent.setup();
      const description = screen.getByDisplayValue('old description');
      await user.clear(description);
      await user.type(description, 'updated description');
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(saved).toHaveBeenCalledOnce());
      expect(saved.mock.calls[0][0]).toMatchObject({
        cmd: extension.cmd,
        args: extension.args,
        description: 'updated description',
      });
    } finally {
      window.electron = originalElectron;
    }
  });

  it('shows only a mask when an existing secret is present', async () => {
    mockedReadConfig.mockResolvedValue({ maskedValue: 'actual-secret-must-not-render' });

    renderWithIntl(
      <ExtensionModal
        title="Configure Tavily"
        initialData={{
          name: 'tavily',
          description: '',
          type: 'stdio',
          cmd: 'npx -y tavily-mcp@latest',
          endpoint: '',
          enabled: false,
          timeout: 300,
          envVars: [{ key: 'TAVILY_API_KEY', value: '••••••••', isEdited: false }],
          headers: [],
        }}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        submitLabel="Save"
        modalType="edit"
      />
    );

    await waitFor(() => expect(mockedReadConfig).toHaveBeenCalledWith('TAVILY_API_KEY', true));
    expect(screen.getByDisplayValue('••••••••')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('actual-secret-must-not-render')).not.toBeInTheDocument();
  });

  it('shows an empty value when the declared secret has not been stored', async () => {
    mockedReadConfig.mockResolvedValue(null);

    renderWithIntl(
      <ExtensionModal
        title="Configure Tavily"
        initialData={{
          name: 'tavily',
          description: '',
          type: 'stdio',
          cmd: 'npx -y tavily-mcp@latest',
          endpoint: '',
          enabled: false,
          timeout: 300,
          envVars: [{ key: 'TAVILY_API_KEY', value: '••••••••', isEdited: false }],
          headers: [],
        }}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        submitLabel="Save"
        modalType="edit"
      />
    );

    await waitFor(() => expect(screen.queryByDisplayValue('••••••••')).not.toBeInTheDocument());
    expect(screen.getByDisplayValue('TAVILY_API_KEY')).toBeInTheDocument();
  });

  it('waits for the asynchronous save before closing', async () => {
    const user = userEvent.setup();
    let finishSave: (() => void) | undefined;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        })
    );
    const onClose = vi.fn();

    renderWithIntl(
      <ExtensionModal
        title="Edit Extension"
        initialData={{
          name: 'tavily',
          description: '',
          type: 'stdio',
          cmd: 'npx -y tavily-mcp@latest',
          endpoint: '',
          enabled: false,
          timeout: 300,
          envVars: [],
          headers: [],
        }}
        onClose={onClose}
        onSubmit={onSubmit}
        submitLabel="Save"
        modalType="edit"
      />
    );

    await user.click(screen.getByTestId('extension-submit-btn'));
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('extension-submit-btn')).toHaveTextContent('Save…');

    finishSave?.();
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('keeps the editor open and reports an asynchronous save failure', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    renderWithIntl(
      <ExtensionModal
        title="Edit Extension"
        initialData={{
          name: 'tavily',
          description: '',
          type: 'stdio',
          cmd: 'npx -y tavily-mcp@latest',
          endpoint: '',
          enabled: false,
          timeout: 300,
          envVars: [],
          headers: [],
        }}
        onClose={onClose}
        onSubmit={vi.fn().mockRejectedValue(new Error('backend rejected update'))}
        submitLabel="Save"
        modalType="edit"
      />
    );

    await user.click(screen.getByTestId('extension-submit-btn'));

    expect(await screen.findByRole('alert')).toHaveTextContent('backend rejected update');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('explains an HTTP failure, preserves literal details and allows retry without losing input', async () => {
    const user = userEvent.setup();
    const error =
      'failed to initialize MCP client: Transport<' +
      'WorkerTransport'.repeat(100) +
      '> HTTP 404 Not Found: <html><script>bad()</script></html>';
    const onClose = vi.fn();
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new Error(error))
      .mockResolvedValueOnce(undefined);
    renderWithIntl(
      <ExtensionModal
        title="Add extension"
        initialData={{
          name: 'my MCP',
          description: 'Keep this input',
          type: 'streamable_http',
          endpoint: 'http://192.168.9.120:8888',
          enabled: true,
          timeout: 300,
          envVars: [],
          headers: [],
        }}
        onSubmit={onSubmit}
        onClose={onClose}
        modalType="add"
        submitLabel="Save"
      />
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveFocus();
    expect(alert).toHaveTextContent('Extension was not saved');
    expect(alert).toHaveTextContent('HTTP 404: The server responded');
    expect(alert.querySelector('details')).not.toHaveAttribute('open');
    await user.click(screen.getByText('Error details'));
    expect(alert.querySelector('details')).toHaveAttribute('open');
    expect(alert.querySelector('pre')?.textContent).toBe(error);
    expect(alert.querySelector('script')).toBeNull();
    expect(screen.getByDisplayValue('Keep this input')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('announces connection test errors and clears them after a successful test', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onTest = vi
      .fn()
      .mockRejectedValueOnce(new Error('HTTP 401 Unauthorized'))
      .mockResolvedValueOnce({
        success: true,
        latencyMs: 15,
        tools: [],
        resourceCount: 0,
        supportsResources: false,
      });
    renderWithIntl(
      <ExtensionModal
        title="Add extension"
        initialData={{
          name: 'my MCP',
          description: '',
          type: 'streamable_http',
          endpoint: 'http://localhost:8888/mcp',
          enabled: true,
          timeout: 300,
          envVars: [],
          headers: [],
        }}
        onSubmit={onSubmit}
        onTest={onTest}
        onClose={vi.fn()}
        modalType="add"
        submitLabel="Save"
      />
    );
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection test failed');
    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 401');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Connected in 15 ms');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('locks managed MCP identity fields while leaving its secret value editable', () => {
    renderWithIntl(
      <ExtensionModal
        title="Configure Tavily"
        initialData={{
          name: 'tavily',
          description: 'Web search and extraction.',
          type: 'stdio',
          cmd: 'npx -y tavily-mcp@latest',
          endpoint: '',
          enabled: false,
          timeout: 300,
          envVars: [{ key: 'TAVILY_API_KEY', value: '••••••••', isEdited: false }],
          headers: [],
        }}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        submitLabel="Save"
        modalType="edit"
        baseConfigurationReadOnly
      />
    );

    expect(screen.getByDisplayValue('tavily')).toBeDisabled();
    expect(screen.getByDisplayValue('npx -y tavily-mcp@latest')).toBeDisabled();
    expect(screen.getByDisplayValue('300')).toBeDisabled();
    expect(screen.getByDisplayValue('••••••••')).toBeEnabled();
  });

  it('tests a valid connection without saving the extension', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onTest = vi.fn().mockResolvedValue({
      success: true,
      latencyMs: 12,
      tools: ['filesystem__read_file'],
      resourceCount: 0,
      supportsResources: false,
    });

    renderWithIntl(
      <ExtensionModal
        title="Add custom extension"
        initialData={{
          name: 'filesystem',
          description: '',
          type: 'stdio',
          cmd: 'server D:\\allowed',
          endpoint: '',
          enabled: true,
          timeout: 300,
          envVars: [],
          headers: [],
        }}
        onClose={vi.fn()}
        onSubmit={onSubmit}
        onTest={onTest}
        submitLabel="Add Extension"
        modalType="add"
      />
    );

    await user.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => expect(onTest).toHaveBeenCalledOnce());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Connected in 12 ms · 1 tools · 0 resources'
    );
  });

  it('does not show unsaved changes dialog when closing without modifications', async () => {
    const user = userEvent.setup();
    const mockOnSubmit = vi.fn();
    const mockOnClose = vi.fn();

    const initialData: ExtensionFormData = {
      name: 'Existing Extension',
      description: 'An existing extension',
      type: 'stdio',
      cmd: 'npx some-mcp-server',
      endpoint: '',
      enabled: true,
      timeout: 300,
      envVars: [
        { key: 'API_KEY', value: '••••••••', isEdited: false },
        { key: 'OTHER_VAR', value: '••••••••', isEdited: false },
      ],
      headers: [],
    };

    renderWithIntl(
      <ExtensionModal
        title="Edit Extension"
        initialData={initialData}
        onClose={mockOnClose}
        onSubmit={mockOnSubmit}
        submitLabel="Save"
        modalType="edit"
      />
    );

    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    await user.click(cancelButton);

    expect(mockOnClose).toHaveBeenCalled();

    expect(screen.queryByText('Unsaved Changes')).not.toBeInTheDocument();
  });

  it('shows unsaved changes dialog when name is modified', async () => {
    const user = userEvent.setup();
    const mockOnSubmit = vi.fn();
    const mockOnClose = vi.fn();

    const initialData: ExtensionFormData = {
      name: 'Original Name',
      description: 'An existing extension',
      type: 'stdio',
      cmd: 'npx some-mcp-server',
      endpoint: '',
      enabled: true,
      timeout: 300,
      envVars: [],
      headers: [],
    };

    renderWithIntl(
      <ExtensionModal
        title="Edit Extension"
        initialData={initialData}
        onClose={mockOnClose}
        onSubmit={mockOnSubmit}
        submitLabel="Save"
        modalType="edit"
      />
    );

    const nameInput = screen.getByPlaceholderText('Enter extension name...');
    await user.clear(nameInput);
    await user.type(nameInput, 'New Name');

    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    await user.click(cancelButton);

    expect(screen.getByText('Unsaved Changes')).toBeInTheDocument();
    expect(mockOnClose).not.toHaveBeenCalled();
  });

  it('shows unsaved changes dialog when description is modified', async () => {
    const user = userEvent.setup();
    const mockOnSubmit = vi.fn();
    const mockOnClose = vi.fn();

    const initialData: ExtensionFormData = {
      name: 'Test Extension',
      description: 'Original description',
      type: 'stdio',
      cmd: 'npx some-mcp-server',
      endpoint: '',
      enabled: true,
      timeout: 300,
      envVars: [],
      headers: [],
    };

    renderWithIntl(
      <ExtensionModal
        title="Edit Extension"
        initialData={initialData}
        onClose={mockOnClose}
        onSubmit={mockOnSubmit}
        submitLabel="Save"
        modalType="edit"
      />
    );

    const descriptionInput = screen.getByPlaceholderText('Optional description...');
    await user.clear(descriptionInput);
    await user.type(descriptionInput, 'New description');

    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    await user.click(cancelButton);

    expect(screen.getByText('Unsaved Changes')).toBeInTheDocument();
    expect(mockOnClose).not.toHaveBeenCalled();
  });

  it('shows unsaved changes dialog when timeout is modified', async () => {
    const user = userEvent.setup();
    const mockOnSubmit = vi.fn();
    const mockOnClose = vi.fn();

    const initialData: ExtensionFormData = {
      name: 'Test Extension',
      description: 'An extension',
      type: 'stdio',
      cmd: 'npx some-mcp-server',
      endpoint: '',
      enabled: true,
      timeout: 300,
      envVars: [],
      headers: [],
    };

    renderWithIntl(
      <ExtensionModal
        title="Edit Extension"
        initialData={initialData}
        onClose={mockOnClose}
        onSubmit={mockOnSubmit}
        submitLabel="Save"
        modalType="edit"
      />
    );

    const timeoutInput = screen.getByDisplayValue('300');
    await user.clear(timeoutInput);
    await user.type(timeoutInput, '600');

    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    await user.click(cancelButton);

    expect(screen.getByText('Unsaved Changes')).toBeInTheDocument();
    expect(mockOnClose).not.toHaveBeenCalled();
  });

  it('creates a http_streamable extension', async () => {
    const user = userEvent.setup();
    const mockOnSubmit = vi.fn();
    const mockOnClose = vi.fn();

    const initialData: ExtensionFormData = {
      name: '',
      description: '',
      type: 'stdio', // Default type
      cmd: '',
      endpoint: '',
      enabled: true,
      timeout: 300,
      envVars: [],
      headers: [],
    };

    renderWithIntl(
      <ExtensionModal
        title="Add custom extension"
        initialData={initialData}
        onClose={mockOnClose}
        onSubmit={mockOnSubmit}
        submitLabel="Add Extension"
        modalType="add"
      />
    );

    const nameInput = screen.getByPlaceholderText('Enter extension name...');
    const submitButton = screen.getByTestId('extension-submit-btn');

    await user.type(nameInput, 'Test MCP');

    const typeSelect = screen.getByRole('combobox');
    await user.click(typeSelect);

    const httpOption = screen.getByText('Streamable HTTP');
    await user.click(httpOption);

    await waitFor(() => {
      expect(screen.getByText('Request Headers')).toBeInTheDocument();
    });

    const endpointInput = screen.getByPlaceholderText('Enter endpoint URL...');
    await user.type(endpointInput, 'https://foo.bar.com/mcp/');

    const descriptionInput = screen.getByPlaceholderText('Optional description...');
    await user.type(descriptionInput, 'Test MCP extension');

    const headerNameInput = screen.getByPlaceholderText('Header name');
    const headerValueInput = screen
      .getAllByPlaceholderText('Value')
      .find(
        (input) =>
          input.closest('div')?.textContent?.includes('Request Headers') ||
          input.parentElement?.parentElement?.textContent?.includes('Request Headers')
      );

    await user.type(headerNameInput, 'Authorization');
    if (headerValueInput) {
      await user.type(headerValueInput, 'Bearer abc123');
    }

    await user.click(submitButton);

    await waitFor(() => {
      expect(mockOnSubmit).toHaveBeenCalled();
    });

    const submittedData = mockOnSubmit.mock.calls[0][0];

    expect(submittedData.name).toBe('Test MCP');
    expect(submittedData.type).toBe('streamable_http');
    expect(submittedData.endpoint).toBe('https://foo.bar.com/mcp/');
    expect(submittedData.description).toBe('Test MCP extension');
    expect(submittedData.timeout).toBe(300);
    expect(submittedData.headers).toHaveLength(1);
    expect(submittedData.headers).toEqual([
      { key: 'Authorization', value: 'Bearer abc123', isEdited: true },
    ]);
  }, 10_000);

  describe('pending env var capture (fix for #8969)', () => {
    beforeEach(() => {
      mockedUpsertConfig.mockClear();
      mockedUpsertConfig.mockResolvedValue(undefined);
    });

    const emptyInitialData: ExtensionFormData = {
      name: '',
      description: '',
      type: 'stdio',
      cmd: '',
      endpoint: '',
      enabled: true,
      timeout: 300,
      envVars: [],
      headers: [],
    };

    // Returns the env-var key+value inputs (scoped to the "Environment Variables" section,
    // disambiguated from the header inputs which share the "Value" placeholder).
    function getEnvVarInputs() {
      const envVarKeyInput = screen.getByPlaceholderText('Variable name');
      const envVarValueInput = screen
        .getAllByPlaceholderText('Value')
        .find((input) =>
          input.parentElement?.parentElement?.parentElement?.textContent?.includes(
            'Environment Variables'
          )
        );
      return { envVarKeyInput, envVarValueInput };
    }

    it('captures a pending env var typed but not "+ Added" when Submit is clicked', async () => {
      const user = userEvent.setup();
      const mockOnSubmit = vi.fn();
      const mockOnClose = vi.fn();

      renderWithIntl(
        <ExtensionModal
          title="Add custom extension"
          initialData={emptyInitialData}
          onClose={mockOnClose}
          onSubmit={mockOnSubmit}
          submitLabel="Add Extension"
          modalType="add"
        />
      );

      await user.type(screen.getByPlaceholderText('Enter extension name...'), 'WooMCP');
      await user.type(
        screen.getByPlaceholderText(/^e\.g\. npx/),
        'npx -y @automattic/mcp-wordpress-remote@latest'
      );

      const { envVarKeyInput, envVarValueInput } = getEnvVarInputs();
      await user.type(envVarKeyInput, 'JWT_TOKEN');
      if (envVarValueInput) {
        await user.type(envVarValueInput, 'my_very_long_token');
      }

      // Note: intentionally NOT clicking the "+ Add" button — this is the #8969 repro.
      await user.click(screen.getByTestId('extension-submit-btn'));

      await waitFor(() => {
        expect(mockOnSubmit).toHaveBeenCalled();
      });

      expect(mockedUpsertConfig).toHaveBeenCalledWith('JWT_TOKEN', 'my_very_long_token', true);

      const submittedData = mockOnSubmit.mock.calls[0][0];
      expect(submittedData.envVars).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: 'JWT_TOKEN',
            value: 'my_very_long_token',
            isEdited: true,
          }),
        ])
      );
    }, 10_000);

    it('does not capture a pending env var when only the key is filled', async () => {
      const user = userEvent.setup();
      const mockOnSubmit = vi.fn();
      const mockOnClose = vi.fn();

      renderWithIntl(
        <ExtensionModal
          title="Add custom extension"
          initialData={emptyInitialData}
          onClose={mockOnClose}
          onSubmit={mockOnSubmit}
          submitLabel="Add Extension"
          modalType="add"
        />
      );

      await user.type(screen.getByPlaceholderText('Enter extension name...'), 'WooMCP');
      await user.type(screen.getByPlaceholderText(/^e\.g\. npx/), 'npx -y something');

      const { envVarKeyInput } = getEnvVarInputs();
      await user.type(envVarKeyInput, 'LONELY_KEY');
      // Intentionally leaving the value field empty.

      await user.click(screen.getByTestId('extension-submit-btn'));

      await waitFor(() => {
        expect(mockOnSubmit).toHaveBeenCalled();
      });

      expect(mockedUpsertConfig).not.toHaveBeenCalledWith(
        'LONELY_KEY',
        expect.anything(),
        expect.anything()
      );

      const submittedData = mockOnSubmit.mock.calls[0][0];
      expect(submittedData.envVars).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ key: 'LONELY_KEY' })])
      );
    });
  });
});
