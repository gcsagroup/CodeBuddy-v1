import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import ImageGenerationSettings from './ImageGenerationSettings';
import MediaServiceTest from './MediaServiceTest';
import MediaServiceForm from './MediaServiceForm';
import { t, type Registry } from './mediaServices';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../../acp/acpConnection', () => ({
  getAcpControlClient: async () => ({ extMethod: request }),
}));
const m = { id: 'auto-image', label: 'Auto', modes: ['text_to_image'] };
const v = { id: 'auto-video', label: 'Auto video', modes: ['image_to_video'] };
const state: Registry = {
  revision: 2,
  defaults: {
    image: { service: 'legacy', model: m.id },
    video: { service: 'legacy', model: v.id },
  },
  services: [
    {
      id: 'legacy',
      name: 'ComfyUI',
      type: 'comfy',
      url: 'http://old:8188',
      models: [m, v],
      hasKey: false,
    },
  ],
  catalog: {
    comfy: { urls: [], models: [m, v] },
    openai: { urls: ['https://api.openai.com/v1'], models: [] },
    fal: { urls: [], models: [] },
    ark: { urls: [], models: [] },
    bailian: { urls: [], models: [] },
  },
};
beforeEach(() => {
  request.mockReset().mockResolvedValue(state);
});
afterEach(cleanup);
it('keeps existing selections on refresh and saves a discovered model only after the user checks it', async () => {
  const existing = { ...state.services[0], type: 'ark' as const, url: 'https://ark.cn-beijing.volces.com/api/v3' };
  request.mockResolvedValueOnce({ models: [{ ...v, id: 'new-version', label: 'New version' }] });
  render(<MediaServiceForm choice="ark" existing={existing} state={state} onBack={vi.fn()} onSaved={vi.fn()} />, { wrapper: IntlTestWrapper });
  fireEvent.click(screen.getByRole('button', { name: t('Refresh official models', '刷新官方模型', '重新整理官方模型') }));
  const newModel = await screen.findByRole('checkbox', { name: /New version/ });
  expect(newModel).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: /^Auto video/ })).toBeChecked();
  expect(request).toHaveBeenCalledTimes(1);
  fireEvent.click(newModel);
  fireEvent.click(screen.getByText(t('Save configuration', '保存配置', '儲存設定')));
  await waitFor(() => expect(request).toHaveBeenLastCalledWith('_codebuddy/media/settings/save',
    expect.objectContaining({ models: expect.arrayContaining([expect.objectContaining({id: m.id}), expect.objectContaining({id: 'new-version'})]) })));
});
afterEach(() => localStorage.removeItem('media-test:legacy'));
it('keeps the migrated defaults and submits a custom image connection only on save', async () => {
  render(<ImageGenerationSettings />, { wrapper: IntlTestWrapper });
  const add = await screen.findByText(t('Add service', '添加服务', '新增服務'));
  fireEvent.click(add);
  fireEvent.click(screen.getByText(t('Custom service', '自定义服务', '自訂服務')));
  fireEvent.click(screen.getByText(t('Next', '下一步', '下一步')));
  fireEvent.change(screen.getByLabelText(t('Service name', '服务名称', '服務名稱')), {
    target: { value: 'Gateway' },
  });
  fireEvent.change(screen.getByLabelText(t('Service address', '服务地址', '服務位址')), {
    target: { value: 'https://gateway.test/v1' },
  });
  fireEvent.change(screen.getByLabelText(t('Model ID', '模型 ID', '模型 ID')), {
    target: { value: 'image-demo' },
  });
  request.mockRejectedValueOnce(Error('Offline'));
  fireEvent.click(screen.getByText(t('Save configuration', '保存配置', '儲存設定')));
  expect(await screen.findByRole('status')).toHaveTextContent('Offline');
  expect(request).toHaveBeenLastCalledWith(
    '_codebuddy/media/settings/save',
    expect.objectContaining({
      revision: 2,
      name: 'Gateway',
      type: 'openai',
      custom: true,
      models: [{ id: 'image-demo', label: 'image-demo', modes: ['text_to_image'] }],
    })
  );
});
it('shows the fee confirmation before a test and never submits while opening the form', async () => {
  render(<ImageGenerationSettings />, { wrapper: IntlTestWrapper });
  fireEvent.click(
    await screen.findByRole('button', { name: t('Manage ', '管理', '管理') + 'ComfyUI' })
  );
  fireEvent.click(screen.getByText(t('Generation test', '生成测试', '生成測試')));
  expect(screen.getByText(t('Confirm and generate', '确认生成', '確認生成'))).toBeEnabled();
  expect(request).toHaveBeenCalledTimes(1);
});

it.each(['completed', 'failed', 'cancelled'])(
  'unlocks both selectors after restoring a %s test and only submits on confirmation',
  async (status) => {
    const record = { model: m.id, mode: m.modes[0], jobId: 'previous', kind: 'image' };
    localStorage.setItem('media-test:legacy', JSON.stringify(record));
    const service = {
      ...state.services[0],
      models: [m, { ...v, modes: ['text_to_video', 'image_to_video'] }],
    };
    request.mockResolvedValueOnce({
      jobId: record.jobId,
      status,
      file: status === 'completed' ? 'saved.png' : null,
    });
    render(<MediaServiceTest service={service} />, { wrapper: IntlTestWrapper });
    const [model, task] = screen.getAllByRole('combobox');
    expect(model).toBeDisabled();
    expect(task).toBeDisabled();
    const confirm = await screen.findByRole('button', {
      name: t('Confirm and generate', '确认生成', '確認生成'),
    });
    expect(model).toBeEnabled();
    expect(task).toBeEnabled();
    fireEvent.change(model, { target: { value: v.id } });
    fireEvent.change(task, { target: { value: 'image_to_video' } });
    expect(screen.getByRole('status')).toHaveTextContent(m.label);
    if (status === 'completed')
      expect(screen.getByText(t('Open result', '打开结果', '開啟結果'))).toBeEnabled();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('_codebuddy/media/settings/test-status', {
      ...record,
      service: service.id,
    });
    request.mockResolvedValueOnce({ status: 'queued' });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith('_codebuddy/media/settings/test', {
        service: service.id,
        model: v.id,
        mode: 'image_to_video',
        kind: 'video',
        jobId: expect.any(String),
        confirmCharge: true,
      })
    );
    expect(JSON.parse(localStorage.getItem('media-test:legacy')!).jobId).not.toBe(record.jobId);
    expect(model).toBeDisabled();
    expect(task).toBeDisabled();
  }
);
