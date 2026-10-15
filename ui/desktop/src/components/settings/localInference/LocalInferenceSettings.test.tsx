import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import { listLocalModels } from '../../../acp/local-inference';
import { LocalInferenceSettings } from './LocalInferenceSettings';

vi.mock('../../../acp/local-inference', () => ({
  listLocalModels: vi.fn(),
  downloadHfModel: vi.fn(),
  getLocalModelDownloadProgress: vi.fn(),
  cancelLocalModelDownload: vi.fn(),
  deleteLocalModel: vi.fn(),
  evictLocalModel: vi.fn(),
}));

vi.mock('../../ModelAndProviderContext', () => ({
  useModelAndProvider: () => ({
    currentModel: '',
    currentProvider: '',
    refreshCurrentModelAndProvider: vi.fn(),
  }),
}));

vi.mock('../../../acp/providers', () => ({
  acpSaveDefaults: vi.fn(),
}));

vi.mock('../auth/HuggingFaceSignInPrompt', () => ({
  default: () => <div>Hugging Face sign-in prompt</div>,
}));

vi.mock('./HuggingFaceModelSearch', () => ({
  HuggingFaceModelSearch: () => <div>Hugging Face model search</div>,
}));

vi.mock('./ModelSettingsPanel', () => ({
  ModelSettingsPanel: () => null,
}));

const mockedListLocalModels = vi.mocked(listLocalModels);

describe('LocalInferenceSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedListLocalModels.mockResolvedValue([
      {
        id: 'bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M',
        repoId: 'bartowski/Llama-3.2-1B-Instruct-GGUF',
        filename: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf',
        quantization: 'Q4_K_M',
        sizeBytes: 1_000_000_000,
        status: { state: 'NotDownloaded' },
        recommended: true,
        visionCapable: false,
        isLoaded: false,
        settings: {
          repeatPenalty: 1,
          repeatLastN: 64,
          frequencyPenalty: 0,
          presencePenalty: 0,
          useMlock: false,
          enableThinking: false,
          visionCapable: false,
          imageTokenEstimate: 0,
          mmprojSizeBytes: 0,
        },
      },
    ]);
  });

  it('hides the sign-in area while keeping local model download and search', async () => {
    render(<LocalInferenceSettings />, { wrapper: IntlTestWrapper });

    expect(await screen.findByText('Featured Models')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(screen.getByText('Hugging Face model search')).toBeInTheDocument();
    expect(screen.queryByText('Hugging Face sign-in prompt')).not.toBeInTheDocument();
  });
});
