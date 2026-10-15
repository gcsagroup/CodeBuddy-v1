import { StrictMode } from 'react';
import { IntlProvider } from 'react-intl';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAcpClient } from '../../acp/acpConnection';
import {
  acpCreateCustomProviderFromRequest as create,
  acpDiscoverCustomProviderModels as discover,
  acpSaveDefaults as save,
} from '../../acp/providers';
import zhMessages from '../../i18n/compiled/zh-CN.json';
import OnboardingGuard from './OnboardingGuard';
const refresh = vi.fn();
const read = vi.fn();
const configure = vi.fn();
vi.mock('../ModelAndProviderContext', () => ({
  useModelAndProvider: () => ({ refreshCurrentModelAndProvider: refresh }),
}));
vi.mock('../../acp/acpConnection', () => ({ getAcpClient: vi.fn() }));
vi.mock('../../acp/providers', () => ({
  acpCreateCustomProviderFromRequest: vi.fn(),
  acpDiscoverCustomProviderModels: vi.fn(),
  acpSaveDefaults: vi.fn(),
}));
function guard({ requireModel = true } = {}) {
  return (
    <StrictMode>
      <IntlProvider locale="zh-CN" messages={zhMessages}>
        <OnboardingGuard onConfigure={configure} requireModel={requireModel}>
          <div>chat</div>
        </OnboardingGuard>
      </IntlProvider>
    </StrictMode>
  );
}
function show(options = {}) {
  return render(guard(options));
}
describe('OnboardingGuard', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getAcpClient).mockResolvedValue({
      goose: { defaultsRead_unstable: read },
    } as unknown as Awaited<ReturnType<typeof getAcpClient>>);
    read.mockResolvedValue({ providerId: null, modelId: null });
    vi.mocked(discover).mockResolvedValue([' only-model ', 'only-model']);
    vi.mocked(create).mockResolvedValue({ provider_name: 'custom_lan' });
    vi.mocked(save).mockResolvedValue(undefined);
    refresh.mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it('waits for persistence and context refresh and creates once under StrictMode', async () => {
    let finish!: () => void;
    refresh.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      })
    );
    show();
    expect(screen.getByRole('status')).toHaveTextContent('正在加载提供商');
    await act(async () => {});
    expect(screen.queryByText('chat')).not.toBeInTheDocument();
    expect(create).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('custom_lan', 'only-model');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        api_url: 'http://192.168.9.120:8001',
        requires_auth: false,
        api_key: '',
        models: ['only-model'],
      })
    );
    await act(async () => finish());
    expect(screen.getByText('chat')).toBeInTheDocument();
  });
  it.each([
    { providerId: 'existing', modelId: 'chosen' },
    { providerId: 'existing', modelId: null },
    { providerId: null, modelId: 'chosen' },
  ])('preserves user defaults %j', async (defaults) => {
    read.mockResolvedValue(defaults);
    show();
    expect(await screen.findByText('chat')).toBeInTheDocument();
    expect(discover).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
  it('recovers from offline failure using Retry', async () => {
    vi.mocked(discover).mockRejectedValueOnce(new Error('offline'));
    show();
    fireEvent.click(await screen.findByRole('button', { name: '重试' }));
    expect(await screen.findByText('chat')).toBeInTheDocument();
    expect(save).toHaveBeenCalledTimes(1);
  });
  it('offers configuration after setup fails without requiring another retry', async () => {
    vi.mocked(discover).mockRejectedValue(new Error('offline'));
    show();
    await screen.findByRole('button', { name: '重试' });
    fireEvent.click(screen.getByRole('button', { name: '进入配置' }));
    expect(configure).toHaveBeenCalledOnce();
    expect(discover).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });
  it('allows configuration while automatic discovery is still pending', async () => {
    let finish!: (models: string[]) => void;
    vi.mocked(discover).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    show();
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: '进入配置' }));
    expect(configure).toHaveBeenCalledOnce();
    await act(async () => finish([]));
  });
  it('does not gate settings on a configured model or contact the automatic endpoint', async () => {
    show({ requireModel: false });
    expect(screen.getByText('chat')).toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
  it('uses the saved manual model when returning from settings', async () => {
    vi.mocked(discover).mockRejectedValue(new Error('offline'));
    const view = show();
    fireEvent.click(await screen.findByRole('button', { name: '进入配置' }));
    view.rerender(guard({ requireModel: false }));
    expect(screen.getByText('chat')).toBeInTheDocument();
    read.mockResolvedValue({ providerId: 'manual-provider', modelId: 'selected-model' });
    view.rerender(guard());
    expect(await screen.findByText('chat')).toBeInTheDocument();
    expect(read).toHaveBeenCalled();
    expect(discover).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });
  it.each([{ models: [] }, { models: [' ', ''] }, { models: ['one', 'two'] }])(
    'rejects ambiguous or empty models %j',
    async ({ models }) => {
      vi.mocked(discover).mockResolvedValue(models);
      show();
      expect(await screen.findByRole('button', { name: '重试' })).toBeInTheDocument();
      expect(screen.getByText('http://192.168.9.120:8001')).toBeInTheDocument();
      expect(
        screen.getByText(
          models.length === 2 && models[0] === 'one'
            ? '服务返回了多个模型，请进入配置选择要使用的默认模型。'
            : '服务未返回任何模型。请联系服务管理员提供可用模型，然后重试。'
        )
      ).toBeInTheDocument();
      expect(screen.queryByText('chat')).not.toBeInTheDocument();
      expect(create).not.toHaveBeenCalled();
    }
  );
  it('bounds stalled discovery and ignores late results', async () => {
    vi.useFakeTimers();
    let finish!: (models: string[]) => void;
    vi.mocked(discover).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    show();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_001);
    });
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    await act(async () => finish(['late']));
    expect(create).not.toHaveBeenCalled();
  });
  it('preserves defaults changed during discovery', async () => {
    read
      .mockResolvedValueOnce({ providerId: null, modelId: null })
      .mockResolvedValue({ providerId: 'user', modelId: 'choice' });
    show();
    expect(await screen.findByText('chat')).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
  it('allows retry after persistence fails', async () => {
    vi.mocked(save).mockRejectedValueOnce(new Error('disk'));
    show();
    fireEvent.click(await screen.findByRole('button', { name: '重试' }));
    expect(await screen.findByText('chat')).toBeInTheDocument();
    expect(save).toHaveBeenCalledTimes(2);
  });
  it('does not write defaults when provider creation fails', async () => {
    vi.mocked(create).mockRejectedValue(new Error('provider unavailable'));
    show();
    expect(await screen.findByRole('button', { name: '重试' })).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });
  it('does not treat unreadable user defaults as a fresh install', async () => {
    read.mockRejectedValue(new Error('config unreadable'));
    show();
    expect(await screen.findByRole('button', { name: '重试' })).toBeInTheDocument();
    expect(discover).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
  it('preserves a user choice made while the provider is being created', async () => {
    read
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValue({ providerId: 'user', modelId: 'choice' });
    show();
    expect(await screen.findByText('chat')).toBeInTheDocument();
    expect(create).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });
});
