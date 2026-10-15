import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toastService } from '../../../toasts';
import { addToAgent, removeFromAgent } from './agent-api';

vi.mock('../../../toasts', () => ({
  toastService: {
    loading: vi.fn(() => 7),
    dismiss: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('../../../acp/session-extensions', () => ({
  addSessionExtension: vi.fn().mockResolvedValue(undefined),
  removeSessionExtension: vi.fn().mockResolvedValue(undefined),
}));

const messages = {
  adding: (name: string) => `正在添加 ${name} 扩展…`,
  added: '已成功添加扩展',
  failedToAdd: '添加扩展失败',
  removing: (name: string) => `正在移除 ${name} 扩展…`,
  removed: '已成功移除扩展',
  failedToRemove: '移除扩展失败',
};

describe('localized session extension feedback', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses caller-provided text when adding an extension', async () => {
    await addToAgent({ name: 'developer', type: 'builtin' }, 'session-1', true, messages);

    expect(toastService.loading).toHaveBeenCalledWith({
      title: 'developer',
      msg: '正在添加 developer 扩展…',
    });
    expect(toastService.success).toHaveBeenCalledWith({
      title: 'developer',
      msg: messages.added,
    });
  });

  it('uses caller-provided text when removing an extension', async () => {
    await removeFromAgent('developer', 'session-1', true, messages);

    expect(toastService.loading).toHaveBeenCalledWith({
      title: 'developer',
      msg: '正在移除 developer 扩展…',
    });
    expect(toastService.success).toHaveBeenCalledWith({
      title: 'developer',
      msg: messages.removed,
    });
  });
});
