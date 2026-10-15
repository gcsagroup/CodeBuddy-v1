import { IntlProvider } from 'react-intl';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acpCreateCustomProviderFromRequest,
  acpDiscoverCustomProviderModels,
} from '../../acp/providers';
import type { UpdateCustomProviderRequest } from '../../types/providers';
import zhMessages from '../../i18n/compiled/zh-CN.json';
import ProviderSelector from './ProviderSelector';

vi.mock('../../acp/providers', () => ({
  acpCreateCustomProviderFromRequest: vi.fn(),
  acpDiscoverCustomProviderModels: vi.fn(),
}));

const localRequest: UpdateCustomProviderRequest = {
  engine: 'ollama_compatible',
  display_name: 'Local Ollama',
  api_url: 'http://127.0.0.1:11434',
  api_key: '',
  models: ['qwen3:8b'],
  supports_streaming: true,
  requires_auth: false,
  headers: {},
};

vi.mock('../settings/providers/modal/subcomponents/forms/CustomProviderForm', () => ({
  default: ({
    compactSetup,
    discoverModels,
    onSubmit,
  }: {
    compactSetup?: boolean;
    discoverModels?: (request: UpdateCustomProviderRequest) => Promise<string[]>;
    onSubmit: (request: UpdateCustomProviderRequest) => Promise<void>;
  }) => (
    <div>
      <span>{compactSetup ? 'compact-manual-connection' : 'catalog-connection'}</span>
      <button type="button" onClick={() => void discoverModels?.(localRequest)}>
        discover-models
      </button>
      <button type="button" onClick={() => void onSubmit(localRequest)}>
        save-connection
      </button>
    </div>
  ),
}));

function renderChinese(ui: React.ReactElement) {
  return render(
    <IntlProvider locale="zh-CN" defaultLocale="en" messages={zhMessages}>
      {ui}
    </IntlProvider>
  );
}

describe('ProviderSelector', () => {
  const createProvider = vi.mocked(acpCreateCustomProviderFromRequest);
  const discoverModels = vi.mocked(acpDiscoverCustomProviderModels);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows only the manual connection path and removes local model deployment', async () => {
    const user = userEvent.setup();
    renderChinese(<ProviderSelector onConfigured={vi.fn()} />);

    expect(screen.queryByText('使用本地模型')).not.toBeInTheDocument();
    expect(screen.queryByText(/Ollama Cloud/)).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();

    const connectButton = screen.getByRole('button', { name: /连接模型/ });
    connectButton.focus();
    await user.keyboard('{Enter}');

    expect(screen.getByText('compact-manual-connection')).toBeInTheDocument();
  });

  it('discovers and saves a manually connected model', async () => {
    discoverModels.mockResolvedValue(['qwen3:8b']);
    createProvider.mockResolvedValue({ provider_name: 'local-ollama' });
    const onConfigured = vi.fn();
    const user = userEvent.setup();
    renderChinese(<ProviderSelector onConfigured={onConfigured} />);

    await user.click(screen.getByRole('button', { name: /连接模型/ }));
    await user.click(screen.getByRole('button', { name: 'discover-models' }));
    await user.click(screen.getByRole('button', { name: 'save-connection' }));

    expect(discoverModels).toHaveBeenCalledWith(localRequest);
    expect(createProvider).toHaveBeenCalledWith(localRequest);
    await waitFor(() => expect(onConfigured).toHaveBeenCalledWith('local-ollama', 'qwen3:8b'));
  });
});
