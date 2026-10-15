import { IntlProvider } from 'react-intl';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acpListProviderModels,
  acpReadProviderConfig,
  acpSaveProviderConfig,
} from '../../acp/providers';
import type { ProviderDetails } from '../../types/providers';
import zhMessages from '../../i18n/compiled/zh-CN.json';
import ProviderConfigForm from './ProviderConfigForm';

vi.mock('../../acp/providers', () => ({
  acpAuthenticateProvider: vi.fn(),
  acpListProviderModels: vi.fn(),
  acpReadProviderConfig: vi.fn(),
  acpSaveProviderConfig: vi.fn(),
}));

const ollamaCloud: ProviderDetails = {
  name: 'ollama_cloud',
  is_configured: false,
  provider_type: 'Declarative',
  metadata: {
    name: 'ollama_cloud',
    display_name: 'Ollama Cloud',
    description: 'Cloud-hosted Ollama models',
    default_model: '',
    model_doc_link: '',
    config_keys: [
      {
        name: 'OLLAMA_CLOUD_API_KEY',
        required: true,
        secret: true,
        oauth_flow: false,
        primary: true,
        credential_validation_supported: true,
        credential_validation_unavailable_reason: null,
      },
    ],
    known_models: [],
    setup_steps: [],
  },
};

const unsupportedProvider: ProviderDetails = {
  ...ollamaCloud,
  name: 'zai',
  metadata: {
    ...ollamaCloud.metadata,
    name: 'zai',
    display_name: 'Z.AI',
    config_keys: [
      {
        name: 'ZAI_API_KEY',
        required: true,
        secret: true,
        oauth_flow: false,
        primary: true,
        credential_validation_supported: false,
        credential_validation_unavailable_reason:
          'Credential pre-validation is not supported for this provider.',
      },
    ],
  },
};

const openai: ProviderDetails = {
  ...ollamaCloud,
  name: 'openai',
  is_configured: true,
  provider_type: 'Builtin',
  metadata: {
    ...ollamaCloud.metadata,
    name: 'openai',
    display_name: 'OpenAI',
    default_model: 'gpt-4o',
    config_keys: [
      {
        name: 'OPENAI_HOST',
        required: true,
        secret: false,
        default: 'https://api.openai.com',
        oauth_flow: false,
        primary: true,
        credential_validation_supported: true,
        credential_validation_unavailable_reason: null,
      },
      {
        name: 'OPENAI_BASE_URL',
        required: false,
        secret: false,
        oauth_flow: false,
        primary: true,
        credential_validation_supported: true,
        credential_validation_unavailable_reason: null,
      },
    ],
  },
};

const liveModels = [{ id: 'qwen3-coder' }, { id: 'gpt-oss:120b' }] as Awaited<
  ReturnType<typeof acpListProviderModels>
>;

function renderChinese(ui: React.ReactElement) {
  return render(
    <IntlProvider locale="zh-CN" defaultLocale="en" messages={zhMessages}>
      {ui}
    </IntlProvider>
  );
}

async function saveApiKey(user: ReturnType<typeof userEvent.setup>) {
  const keyInput = await screen.findByPlaceholderText('你的 API 密钥');
  await user.type(keyInput, 'test-key');
  await user.click(screen.getByRole('button', { name: '继续' }));
}

describe('ProviderConfigForm Ollama Cloud onboarding', () => {
  const listModels = vi.mocked(acpListProviderModels);
  const readConfig = vi.mocked(acpReadProviderConfig);
  const saveConfig = vi.mocked(acpSaveProviderConfig);

  beforeEach(() => {
    vi.clearAllMocks();
    listModels.mockReset();
    readConfig.mockResolvedValue([]);
    saveConfig.mockResolvedValue(undefined);
  });

  it('does not render a submit path when credential pre-validation is unsupported', () => {
    renderChinese(<ProviderConfigForm provider={unsupportedProvider} onConfigured={vi.fn()} />);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Credential pre-validation is not supported for this provider.'
    );
    expect(screen.queryByRole('button', { name: '继续' })).not.toBeInTheDocument();
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('continues with an existing keyring credential without submitting its masked value', async () => {
    readConfig.mockResolvedValue([
      {
        key: 'OLLAMA_CLOUD_API_KEY',
        isSet: true,
        isSecret: true,
        required: true,
        value: '********',
      },
    ]);
    listModels.mockResolvedValue(liveModels);
    const onConfigured = vi.fn();
    const user = userEvent.setup();
    renderChinese(<ProviderConfigForm provider={ollamaCloud} onConfigured={onConfigured} />);

    const keyInput = await screen.findByRole('textbox');
    expect(keyInput).toHaveValue('');
    expect(keyInput).toHaveAttribute('placeholder', '********');
    expect(keyInput).not.toBeRequired();

    await user.click(screen.getByRole('button', { name: '继续' }));

    await waitFor(() => expect(listModels).toHaveBeenCalledWith('ollama_cloud'));
    expect(saveConfig).toHaveBeenCalledWith('ollama_cloud', [], []);
    expect(saveConfig).not.toHaveBeenCalledWith(
      'ollama_cloud',
      expect.arrayContaining([expect.objectContaining({ value: '********' })])
    );
    expect(onConfigured).not.toHaveBeenCalled();
  });

  it('waits for a user-selected live model before completing configuration', async () => {
    listModels.mockResolvedValue(liveModels);
    const onConfigured = vi.fn();
    const user = userEvent.setup();
    renderChinese(<ProviderConfigForm provider={ollamaCloud} onConfigured={onConfigured} />);

    await saveApiKey(user);

    await waitFor(() => expect(listModels).toHaveBeenCalledWith('ollama_cloud'));
    expect(onConfigured).not.toHaveBeenCalled();

    await user.click(await screen.findByRole('combobox'));
    await user.click(await screen.findByText('qwen3-coder'));
    await user.click(screen.getByRole('button', { name: '继续' }));

    await waitFor(() => expect(onConfigured).toHaveBeenCalledWith('ollama_cloud', 'qwen3-coder'));
  });

  it('accepts a non-empty manually entered model only after live inventory succeeds', async () => {
    listModels.mockResolvedValue(liveModels);
    const onConfigured = vi.fn();
    const user = userEvent.setup();
    renderChinese(<ProviderConfigForm provider={ollamaCloud} onConfigured={onConfigured} />);

    await saveApiKey(user);

    const customModel = await screen.findByRole('textbox', { name: '自定义模型名称' });
    await user.type(customModel, '  qwen3.5-custom  ');
    await user.click(screen.getByRole('button', { name: '继续' }));

    await waitFor(() =>
      expect(onConfigured).toHaveBeenCalledWith('ollama_cloud', 'qwen3.5-custom')
    );
  });

  it('does not complete when credential save is rejected and can retry the real save', async () => {
    saveConfig
      .mockRejectedValueOnce(new Error('The provider rejected the credentials.'))
      .mockResolvedValueOnce(undefined);
    listModels.mockResolvedValue(liveModels);
    const onConfigured = vi.fn();
    const user = userEvent.setup();
    renderChinese(<ProviderConfigForm provider={ollamaCloud} onConfigured={onConfigured} />);

    await saveApiKey(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The provider rejected the credentials.'
    );
    expect(onConfigured).not.toHaveBeenCalled();
    expect(listModels).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /继续/ }));
    await waitFor(() => expect(saveConfig).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(listModels).toHaveBeenCalledWith('ollama_cloud'));
    await user.click(await screen.findByRole('combobox'));
    await user.click(await screen.findByText('qwen3-coder'));
    await user.click(screen.getByRole('button', { name: /继续/ }));

    await waitFor(() => expect(onConfigured).toHaveBeenCalledWith('ollama_cloud', 'qwen3-coder'));
  });

  it('allows a manual model after an authenticated account returns an empty inventory', async () => {
    listModels.mockResolvedValueOnce([]);
    const onConfigured = vi.fn();
    const user = userEvent.setup();
    renderChinese(<ProviderConfigForm provider={ollamaCloud} onConfigured={onConfigured} />);

    await saveApiKey(user);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(onConfigured).not.toHaveBeenCalled();
    const customModel = await screen.findByRole('textbox', { name: '自定义模型名称' });
    await user.type(customModel, 'account-private-model');
    await user.click(screen.getByRole('button', { name: '继续' }));

    await waitFor(() =>
      expect(onConfigured).toHaveBeenCalledWith('ollama_cloud', 'account-private-model')
    );
  });

  it('requires a selected or manually entered non-empty model', async () => {
    listModels.mockResolvedValue(liveModels);
    const onConfigured = vi.fn();
    const user = userEvent.setup();
    renderChinese(<ProviderConfigForm provider={ollamaCloud} onConfigured={onConfigured} />);

    await saveApiKey(user);
    await screen.findByRole('combobox');
    await user.click(screen.getByRole('button', { name: '继续' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('请选择或输入模型');
    expect(onConfigured).not.toHaveBeenCalled();
  });

  it('submits a persisted custom OpenAI base URL without requiring the alternate host', async () => {
    readConfig.mockResolvedValue([
      { key: 'OPENAI_HOST', required: true, isSecret: false, isSet: false, value: null },
      {
        key: 'OPENAI_BASE_URL',
        required: false,
        isSecret: false,
        isSet: true,
        value: 'http://127.0.0.1:3000/v1',
      },
    ]);
    const onConfigured = vi.fn();
    const user = userEvent.setup();
    renderChinese(<ProviderConfigForm provider={openai} onConfigured={onConfigured} />);

    await waitFor(() =>
      expect(screen.getByDisplayValue('http://127.0.0.1:3000/v1')).toBeInTheDocument()
    );
    await user.click(screen.getByRole('button', { name: '继续' }));

    await waitFor(() =>
      expect(saveConfig).toHaveBeenCalledWith(
        'openai',
        [{ key: 'OPENAI_BASE_URL', value: 'http://127.0.0.1:3000/v1' }],
        ['OPENAI_HOST']
      )
    );
    expect(onConfigured).toHaveBeenCalledWith('openai');
  });
});
