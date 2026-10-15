import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toastService } from '../../../toasts';
import { activateExtensionDefault, toggleExtensionDefault } from './extension-manager';

vi.mock('../../../toasts', () => ({
  toastService: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../utils/analytics', () => ({
  trackExtensionAdded: vi.fn(),
  trackExtensionEnabled: vi.fn(),
  trackExtensionDisabled: vi.fn(),
  trackExtensionDeleted: vi.fn(),
  getErrorType: vi.fn(() => 'unknown'),
}));

const extensionConfig = {
  name: 'developer',
  type: 'builtin',
} as const;

const messages = {
  enabledInDefaults: '已在默认配置中启用扩展',
  removedFromDefaults: '已从默认配置中移除扩展',
  failedToUpdateDefault: '更新扩展默认状态失败',
  addedAsDefault: '已将扩展添加为默认扩展',
  failedToAdd: '添加扩展失败',
};

describe('localized extension operation feedback', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses caller-provided text when enabling a default extension', async () => {
    await toggleExtensionDefault({
      toggle: 'toggleOn',
      extensionConfig,
      setEnabled: vi.fn().mockResolvedValue(undefined),
      messages,
    });

    expect(toastService.success).toHaveBeenCalledWith({
      title: 'developer',
      msg: messages.enabledInDefaults,
    });
  });

  it('uses caller-provided text when adding a default extension', async () => {
    await activateExtensionDefault({
      addToConfig: vi.fn().mockResolvedValue(undefined),
      extensionConfig,
      messages,
    });

    expect(toastService.success).toHaveBeenCalledWith({
      title: 'developer',
      msg: messages.addedAsDefault,
    });
  });
});
