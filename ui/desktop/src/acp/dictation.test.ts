import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAcpClient } from './acpConnection';
import { deleteDictationSecret, saveDictationSecret, selectLocalDictationModel } from './dictation';

vi.mock('./acpConnection', () => ({
  getAcpClient: vi.fn(),
}));

describe('typed dictation secrets', () => {
  const dictationSecretSave_unstable = vi.fn();
  const dictationSecretDelete_unstable = vi.fn();
  const dictationModelsSelect_unstable = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getAcpClient).mockResolvedValue({
      goose: {
        dictationSecretSave_unstable,
        dictationSecretDelete_unstable,
        dictationModelsSelect_unstable,
      },
    } as never);
  });

  it('trims and saves a secret through the generated typed endpoint exactly once', async () => {
    dictationSecretSave_unstable.mockResolvedValue(undefined);

    await saveDictationSecret('  openai  ', '  secret-value  ');

    expect(dictationSecretSave_unstable).toHaveBeenCalledTimes(1);
    expect(dictationSecretSave_unstable).toHaveBeenCalledWith({
      provider: 'openai',
      value: 'secret-value',
    });
  });

  it('trims and deletes a secret through the generated typed endpoint exactly once', async () => {
    dictationSecretDelete_unstable.mockResolvedValue(undefined);

    await deleteDictationSecret('  groq  ');

    expect(dictationSecretDelete_unstable).toHaveBeenCalledTimes(1);
    expect(dictationSecretDelete_unstable).toHaveBeenCalledWith({ provider: 'groq' });
  });

  it.each([
    ['blank provider', '   ', 'secret-value'],
    ['blank value', 'openai', '   '],
  ])('rejects a %s before acquiring an ACP client', async (_label, provider, value) => {
    await expect(saveDictationSecret(provider, value)).rejects.toThrow(
      'Dictation provider and secret are required'
    );
    expect(getAcpClient).not.toHaveBeenCalled();
  });

  it('rejects a blank delete provider before acquiring an ACP client', async () => {
    await expect(deleteDictationSecret('   ')).rejects.toThrow('Dictation provider is required');
    expect(getAcpClient).not.toHaveBeenCalled();
  });

  it('trims and selects a local model through the typed endpoint exactly once', async () => {
    dictationModelsSelect_unstable.mockResolvedValue(undefined);

    await selectLocalDictationModel('  tiny  ');

    expect(dictationModelsSelect_unstable).toHaveBeenCalledTimes(1);
    expect(dictationModelsSelect_unstable).toHaveBeenCalledWith({
      provider: 'local',
      modelId: 'tiny',
    });
  });

  it('rejects a blank local model before acquiring an ACP client', async () => {
    await expect(selectLocalDictationModel('   ')).rejects.toThrow(
      'Local dictation model is required'
    );
    expect(getAcpClient).not.toHaveBeenCalled();
  });
});
