import type {
  DictationDownloadProgress,
  DictationLocalModelStatus,
  DictationProviderStatusEntry,
} from '@aaif/goose-sdk';
import { getAcpClient } from './acpConnection';

export type { DictationProviderStatusEntry };

export type DictationProviders = Record<string, DictationProviderStatusEntry>;
export type LocalDictationModel = DictationLocalModelStatus;
export type LocalDictationDownloadProgress = DictationDownloadProgress;

export async function getDictationConfig(): Promise<DictationProviders> {
  const client = await getAcpClient();
  const response = await client.goose.dictationConfig_unstable({});
  return response.providers ?? {};
}

export async function saveDictationSecret(provider: string, value: string): Promise<void> {
  const trimmedProvider = provider.trim();
  const trimmedValue = value.trim();
  if (!trimmedProvider || !trimmedValue) {
    throw new Error('Dictation provider and secret are required');
  }
  const client = await getAcpClient();
  await client.goose.dictationSecretSave_unstable({
    provider: trimmedProvider,
    value: trimmedValue,
  });
}

export async function deleteDictationSecret(provider: string): Promise<void> {
  const trimmedProvider = provider.trim();
  if (!trimmedProvider) {
    throw new Error('Dictation provider is required');
  }
  const client = await getAcpClient();
  await client.goose.dictationSecretDelete_unstable({ provider: trimmedProvider });
}

export async function transcribeDictation(
  audio: string,
  mimeType: string,
  provider: string
): Promise<string> {
  const client = await getAcpClient();
  const response = await client.goose.dictationTranscribe_unstable({ audio, mimeType, provider });
  return response.text;
}

export async function listLocalDictationModels(): Promise<LocalDictationModel[]> {
  const client = await getAcpClient();
  const response = await client.goose.dictationModelsList_unstable({});
  return response.models;
}

export async function downloadLocalDictationModel(modelId: string): Promise<void> {
  const client = await getAcpClient();
  await client.goose.dictationModelsDownload_unstable({ modelId });
}

export async function getLocalDictationModelDownloadProgress(
  modelId: string
): Promise<LocalDictationDownloadProgress | null> {
  const client = await getAcpClient();
  const response = await client.goose.dictationModelsDownloadProgress_unstable({ modelId });
  return response.progress ?? null;
}

export async function cancelLocalDictationModelDownload(modelId: string): Promise<void> {
  const client = await getAcpClient();
  await client.goose.dictationModelsCancel_unstable({ modelId });
}

export async function deleteLocalDictationModel(modelId: string): Promise<void> {
  const client = await getAcpClient();
  await client.goose.dictationModelsDelete_unstable({ modelId });
}

export async function selectLocalDictationModel(modelId: string): Promise<void> {
  const trimmedModelId = modelId.trim();
  if (!trimmedModelId) {
    throw new Error('Local dictation model is required');
  }
  const client = await getAcpClient();
  await client.goose.dictationModelsSelect_unstable({
    provider: 'local',
    modelId: trimmedModelId,
  });
}
