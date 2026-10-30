import { useCallback, useState, useRef, useEffect } from 'react';
import { compressImageDataUrl, errorMessage } from '../utils/conversionUtils';

export interface DroppedFile {
  id: string;
  path: string;
  name: string;
  type: string;
  isImage: boolean;
  isVideo: boolean;
  dataUrl?: string;
  frameDataUrls?: string[];
  isLoading?: boolean;
  error?: string;
}

const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const VIDEO_FRAME_COUNT = 6;
const VIDEO_FRAME_MAX_EDGE = 1280;

export function isSupportedVideoFile(file: Pick<File, 'type' | 'name'>): boolean {
  return file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|ogv)$/i.test(file.name);
}

function waitForMediaEvent(
  // TypeScript's DOM library provides this type; ESLint's main-process globals do not.
  // eslint-disable-next-line no-undef
  target: HTMLVideoElement,
  eventName: 'loadedmetadata' | 'seeked',
  timeoutMs = 10_000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for video ${eventName}`));
    }, timeoutMs);
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('Video could not be decoded'));
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      target.removeEventListener(eventName, onEvent);
      target.removeEventListener('error', onError);
    };
    target.addEventListener(eventName, onEvent, { once: true });
    target.addEventListener('error', onError, { once: true });
  });
}

export async function extractVideoFrames(file: File): Promise<string[]> {
  if (file.size > MAX_VIDEO_BYTES) {
    throw new Error('Video is larger than the 200 MB limit');
  }
  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.src = objectUrl;
  try {
    await waitForMediaEvent(video, 'loadedmetadata');
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      throw new Error('Video duration is unavailable');
    }
    const scale = Math.min(1, VIDEO_FRAME_MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable');

    const frames: string[] = [];
    for (let index = 0; index < VIDEO_FRAME_COUNT; index += 1) {
      const seeked = waitForMediaEvent(video, 'seeked');
      video.currentTime = (video.duration * (index + 1)) / (VIDEO_FRAME_COUNT + 1);
      await seeked;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push(canvas.toDataURL('image/jpeg', 0.8));
    }
    return frames;
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(objectUrl);
  }
}

export const useFileDrop = (initialFiles: DroppedFile[] = []) => {
  const [droppedFiles, setDroppedFiles] = useState<DroppedFile[]>(initialFiles);
  const activeReadersRef = useRef<Set<FileReader>>(new Set());

  // Cleanup effect to prevent memory leaks
  useEffect(() => {
    return () => {
      // Abort any active FileReaders on unmount
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const readers = activeReadersRef.current;
      readers.forEach((reader) => {
        try {
          reader.abort();
        } catch {
          // Reader might already be done, ignore errors
        }
      });
      readers.clear();
    };
  }, []);

  const addFiles = useCallback(async (files: FileList) => {
    if (files.length > 0) {
      const droppedFileObjects: DroppedFile[] = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];

        let droppedFile: DroppedFile;

        try {
          const path = window.electron.getPathForFile(file);
          const isImage = file.type.startsWith('image/');
          const isVideo = isSupportedVideoFile(file);

          droppedFile = {
            id: `dropped-${Date.now()}-${i}`,
            path,
            name: file.name,
            type: file.type,
            isImage,
            isVideo,
            isLoading: isImage || isVideo,
          };
        } catch (error) {
          console.error('Error processing file:', file.name, error);
          // Create an error file object
          droppedFile = {
            id: `dropped-error-${Date.now()}-${i}`,
            path: '',
            name: file.name,
            type: file.type,
            isImage: false,
            isVideo: false,
            isLoading: false,
            error: `Failed to get file path: ${errorMessage(error, 'Unknown error')}`,
          };
        }

        droppedFileObjects.push(droppedFile);

        if (droppedFile.isImage && !droppedFile.error) {
          const reader = new FileReader();
          activeReadersRef.current.add(reader);

          reader.onload = async (event) => {
            const dataUrl = event.target?.result as string;
            try {
              // Compress the image
              const compressedDataUrl = await compressImageDataUrl(dataUrl);
              setDroppedFiles((prev) =>
                prev.map((f) =>
                  f.id === droppedFile.id
                    ? { ...f, dataUrl: compressedDataUrl, isLoading: false }
                    : f
                )
              );
            } catch (compressionError) {
              console.error('Failed to compress image:', file.name, compressionError);
              setDroppedFiles((prev) =>
                prev.map((f) =>
                  f.id === droppedFile.id
                    ? { ...f, error: 'Failed to compress image', isLoading: false }
                    : f
                )
              );
            }
            activeReadersRef.current.delete(reader);
          };

          reader.onerror = () => {
            console.error('Failed to read image:', file.name);
            setDroppedFiles((prev) =>
              prev.map((f) =>
                f.id === droppedFile.id
                  ? { ...f, error: 'Failed to load image', isLoading: false }
                  : f
              )
            );
            activeReadersRef.current.delete(reader);
          };

          reader.onabort = () => {
            activeReadersRef.current.delete(reader);
          };

          reader.readAsDataURL(file);
        } else if (droppedFile.isVideo && !droppedFile.error) {
          extractVideoFrames(file)
            .then((frameDataUrls) => {
              setDroppedFiles((prev) =>
                prev.map((item) =>
                  item.id === droppedFile.id ? { ...item, frameDataUrls, isLoading: false } : item
                )
              );
            })
            .catch((videoError) => {
              setDroppedFiles((prev) =>
                prev.map((item) =>
                  item.id === droppedFile.id
                    ? {
                        ...item,
                        error: errorMessage(videoError, 'Failed to extract video frames'),
                        isLoading: false,
                      }
                    : item
                )
              );
            });
        }
      }

      setDroppedFiles((prev) => [...prev, ...droppedFileObjects]);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      return addFiles(e.dataTransfer.files);
    },
    [addFiles]
  );

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  }, []);

  return {
    droppedFiles,
    setDroppedFiles,
    handleDrop,
    handleDragOver,
    addFiles,
  };
};
