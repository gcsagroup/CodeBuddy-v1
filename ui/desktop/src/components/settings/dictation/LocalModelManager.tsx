import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Trash2, X, Check, ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '../../ui/button';
import {
  cancelLocalDictationModelDownload,
  deleteLocalDictationModel,
  downloadLocalDictationModel,
  getDictationConfig,
  getLocalDictationModelDownloadProgress,
  listLocalDictationModels,
  selectLocalDictationModel,
  type LocalDictationDownloadProgress,
  type LocalDictationModel,
} from '../../../acp/dictation';
import { defineMessages, useIntl } from '../../../i18n';

const i18n = defineMessages({
  gpuAcceleration: {
    id: 'localModelManager.gpuAcceleration',
    defaultMessage:
      'Supports GPU acceleration (CUDA for NVIDIA, Metal for Apple Silicon). GPU features must be enabled at build time for hardware acceleration.',
  },
  recommended: {
    id: 'localModelManager.recommended',
    defaultMessage: 'Recommended',
  },
  active: {
    id: 'localModelManager.active',
    defaultMessage: 'Active',
  },
  recommendedForHardware: {
    id: 'localModelManager.recommendedForHardware',
    defaultMessage: 'Recommended for your hardware',
  },
  downloaded: {
    id: 'localModelManager.downloaded',
    defaultMessage: 'Downloaded',
  },
  download: {
    id: 'localModelManager.download',
    defaultMessage: 'Download',
  },
  deleteConfirm: {
    id: 'localModelManager.deleteConfirm',
    defaultMessage: 'Delete this model? You can re-download it later.',
  },
  showRecommendedOnly: {
    id: 'localModelManager.showRecommendedOnly',
    defaultMessage: 'Show recommended only',
  },
  showAllModels: {
    id: 'localModelManager.showAllModels',
    defaultMessage: 'Show all models ({count} more)',
  },
  noModels: {
    id: 'localModelManager.noModels',
    defaultMessage: 'No models available',
  },
});

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
};

const capitalize = (str: string): string => {
  return str.charAt(0).toUpperCase() + str.slice(1);
};

export const LocalModelManager = () => {
  const intl = useIntl();
  const [models, setModels] = useState<LocalDictationModel[]>([]);
  const [downloads, setDownloads] = useState<Map<string, LocalDictationDownloadProgress>>(
    new Map()
  );
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [showAllModels, setShowAllModels] = useState(false);
  const mountedRef = useRef(false);
  const refreshGenerationRef = useRef(0);
  const downloadIntervalsRef = useRef(new Map<string, ReturnType<typeof setInterval>>());
  const downloadGenerationsRef = useRef(new Map<string, number>());
  const downloadPollsInFlightRef = useRef(new Map<string, number>());

  const invalidateDownloadPoll = useCallback((modelId: string) => {
    const nextGeneration = (downloadGenerationsRef.current.get(modelId) ?? 0) + 1;
    downloadGenerationsRef.current.set(modelId, nextGeneration);
    const interval = downloadIntervalsRef.current.get(modelId);
    if (interval) clearInterval(interval);
    downloadIntervalsRef.current.delete(modelId);
  }, []);

  const refreshAuthority = useCallback(async () => {
    if (!mountedRef.current) return;
    const generation = ++refreshGenerationRef.current;
    try {
      const [nextModels, config] = await Promise.all([
        listLocalDictationModels(),
        getDictationConfig(),
      ]);
      if (!mountedRef.current || generation !== refreshGenerationRef.current) return;

      const selected = config.local?.selectedModel;
      const activeSelection =
        typeof selected === 'string' &&
        nextModels.some((model) => model.id === selected && model.downloaded)
          ? selected
          : null;
      setModels(nextModels);
      setSelectedModelId(activeSelection);
    } catch {
      if (!mountedRef.current || generation !== refreshGenerationRef.current) return;
      console.error('Failed to refresh local dictation model state');
      setModels([]);
      setSelectedModelId(null);
    }
  }, []);

  const selectModel = async (modelId: string) => {
    try {
      await selectLocalDictationModel(modelId);
    } catch {
      console.error('Failed to select local dictation model');
    } finally {
      if (mountedRef.current) await refreshAuthority();
    }
  };

  const pollDownloadProgress = useCallback(
    (modelId: string) => {
      if (downloadIntervalsRef.current.has(modelId)) return;

      const generation = (downloadGenerationsRef.current.get(modelId) ?? 0) + 1;
      downloadGenerationsRef.current.set(modelId, generation);
      const poll = async () => {
        if (
          !mountedRef.current ||
          downloadGenerationsRef.current.get(modelId) !== generation ||
          downloadPollsInFlightRef.current.get(modelId) === generation
        ) {
          return;
        }
        downloadPollsInFlightRef.current.set(modelId, generation);
        try {
          const progress = await getLocalDictationModelDownloadProgress(modelId);
          if (!mountedRef.current || downloadGenerationsRef.current.get(modelId) !== generation) {
            return;
          }

          if (progress?.status === 'downloading') {
            setDownloads((prev) => new Map(prev).set(modelId, progress));
            return;
          }

          invalidateDownloadPoll(modelId);
          setDownloads((prev) => {
            const next = new Map(prev);
            next.delete(modelId);
            return next;
          });
          if (mountedRef.current) await refreshAuthority();
        } catch {
          if (!mountedRef.current || downloadGenerationsRef.current.get(modelId) !== generation) {
            return;
          }
          invalidateDownloadPoll(modelId);
          setDownloads((prev) => {
            const next = new Map(prev);
            next.delete(modelId);
            return next;
          });
          if (mountedRef.current) await refreshAuthority();
        } finally {
          if (downloadPollsInFlightRef.current.get(modelId) === generation) {
            downloadPollsInFlightRef.current.delete(modelId);
          }
        }
      };

      const interval = setInterval(() => void poll(), 500);
      downloadIntervalsRef.current.set(modelId, interval);
    },
    [invalidateDownloadPoll, refreshAuthority]
  );

  const startDownload = async (modelId: string) => {
    invalidateDownloadPoll(modelId);
    try {
      await downloadLocalDictationModel(modelId);
      if (mountedRef.current) pollDownloadProgress(modelId);
    } catch {
      console.error('Failed to start local dictation model download');
      if (mountedRef.current) await refreshAuthority();
    }
  };

  const cancelDownload = async (modelId: string) => {
    invalidateDownloadPoll(modelId);
    setDownloads((prev) => {
      const next = new Map(prev);
      next.delete(modelId);
      return next;
    });
    try {
      await cancelLocalDictationModelDownload(modelId);
    } catch {
      console.error('Failed to cancel local dictation model download');
    } finally {
      if (mountedRef.current) await refreshAuthority();
    }
  };

  const deleteModel = async (modelId: string) => {
    if (!window.confirm(intl.formatMessage(i18n.deleteConfirm))) return;

    invalidateDownloadPoll(modelId);
    try {
      await deleteLocalDictationModel(modelId);
    } catch {
      console.error('Failed to delete local dictation model');
    } finally {
      if (mountedRef.current) await refreshAuthority();
    }
  };

  useEffect(() => {
    const downloadIntervals = downloadIntervalsRef.current;
    const downloadGenerations = downloadGenerationsRef.current;
    const downloadPollsInFlight = downloadPollsInFlightRef.current;
    mountedRef.current = true;
    void refreshAuthority();
    return () => {
      mountedRef.current = false;
      refreshGenerationRef.current += 1;
      for (const [modelId, interval] of downloadIntervals) {
        clearInterval(interval);
        downloadGenerations.set(modelId, (downloadGenerations.get(modelId) ?? 0) + 1);
      }
      downloadIntervals.clear();
      downloadPollsInFlight.clear();
    };
  }, [refreshAuthority]);

  useEffect(() => {
    if (!mountedRef.current) return;
    for (const model of models) {
      if (model.downloadInProgress) pollDownloadProgress(model.id);
    }
  }, [models, pollDownloadProgress]);

  const hasDownloadedNonRecommended = models.some(
    (model) => model.downloaded && !model.recommended
  );
  const displayedModels =
    showAllModels || hasDownloadedNonRecommended ? models : models.filter((m) => m.recommended);
  const hasNonRecommendedModels = models.some((m) => !m.recommended);
  const showToggleButton = hasNonRecommendedModels && !hasDownloadedNonRecommended;

  return (
    <div className="space-y-3">
      <div className="text-xs text-text-secondary mb-2">
        <p>{intl.formatMessage(i18n.gpuAcceleration)}</p>
      </div>

      <div className="space-y-2">
        {displayedModels.map((model) => {
          const progress = downloads.get(model.id);
          const isDownloading = model.downloadInProgress || progress?.status === 'downloading';
          const isSelected = selectedModelId === model.id;
          const canSelect = model.downloaded && !isDownloading;

          return (
            <div
              key={model.id}
              className={`border rounded-lg p-3 transition-colors ${
                isSelected
                  ? 'border-text-inverse bg-background-inverse/5'
                  : 'border-border-primary bg-background-primary hover:border-border-primary'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    {canSelect && (
                      <input
                        type="radio"
                        aria-label={model.id}
                        checked={isSelected}
                        onChange={() => void selectModel(model.id)}
                        className="cursor-pointer"
                      />
                    )}
                    <h4 className="text-sm font-medium text-text-primary">
                      {capitalize(model.id)}
                    </h4>
                    <span className="text-xs text-text-secondary">{model.sizeMb}MB</span>
                    {model.recommended && (
                      <span className="text-xs bg-blue-500 text-white px-2 py-0.5 rounded">
                        {intl.formatMessage(i18n.recommended)}
                      </span>
                    )}
                    {isSelected && (
                      <span className="text-xs bg-background-inverse text-white px-2 py-0.5 rounded">
                        {intl.formatMessage(i18n.active)}
                      </span>
                    )}
                  </div>

                  <p className="text-xs text-text-secondary mt-1">{model.description}</p>
                  {model.recommended && (
                    <p className="text-xs text-blue-600 mt-1 font-medium">
                      {intl.formatMessage(i18n.recommendedForHardware)}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {model.downloaded ? (
                    <>
                      <div className="flex items-center gap-1 text-xs text-green-600">
                        <Check className="w-4 h-4" />
                        <span>{intl.formatMessage(i18n.downloaded)}</span>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Delete ${model.id}`}
                        onClick={() => void deleteModel(model.id)}
                        className="text-destructive hover:text-destructive"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </>
                  ) : isDownloading ? (
                    <>
                      <div className="text-xs text-text-secondary min-w-[60px]">
                        {progress ? `${progress.progressPercent.toFixed(0)}%` : '…'}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void cancelDownload(model.id)}
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void startDownload(model.id)}
                    >
                      <Download className="w-4 h-4 mr-1" />
                      {intl.formatMessage(i18n.download)}
                    </Button>
                  )}
                </div>
              </div>

              {isDownloading && progress && (
                <div className="mt-2 space-y-1">
                  <div className="w-full bg-background-secondary rounded-full h-1.5">
                    <div
                      className="bg-background-inverse h-1.5 rounded-full transition-all"
                      style={{ width: `${progress.progressPercent}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-xs text-text-secondary">
                    <span>
                      {formatBytes(progress.bytesDownloaded)} / {formatBytes(progress.totalBytes)}
                    </span>
                  </div>
                </div>
              )}

              {progress?.status === 'failed' && progress.error && (
                <div className="mt-2 text-xs text-destructive">{progress.error}</div>
              )}
            </div>
          );
        })}
      </div>

      {showToggleButton && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowAllModels(!showAllModels)}
          className="w-full text-text-secondary hover:text-text-primary"
        >
          {showAllModels ? (
            <>
              <ChevronUp className="w-4 h-4 mr-1" />
              {intl.formatMessage(i18n.showRecommendedOnly)}
            </>
          ) : (
            <>
              <ChevronDown className="w-4 h-4 mr-1" />
              {intl.formatMessage(i18n.showAllModels, {
                count: models.length - displayedModels.length,
              })}
            </>
          )}
        </Button>
      )}

      {models.length === 0 && (
        <div className="text-center py-6 text-text-secondary text-sm">
          {intl.formatMessage(i18n.noModels)}
        </div>
      )}
    </div>
  );
};
