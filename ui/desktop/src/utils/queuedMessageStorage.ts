import type { ImageData, MessageMetadata } from '../types/message';

export interface StoredQueuedMessage {
  queuedWhileBusy?: true;
  id: string;
  content: string;
  timestamp: number;
  desktopGeneration?: string;
  images: ImageData[];
  delivery?: 'pending' | 'submitting';
  presentation?: MessageMetadata['presentation'];
}

interface QueueSnapshot {
  version: 1;
  sessionId: string;
  revision: string;
  messages: StoredQueuedMessage[];
}

export class QueueStorageConflict extends Error {}

interface QueueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isMessage(value: unknown): value is StoredQueuedMessage {
  if (!value || typeof value !== 'object') return false;
  const item = value as StoredQueuedMessage;
  return (
    typeof item.id === 'string' &&
    item.id.length > 0 &&
    typeof item.content === 'string' &&
    typeof item.timestamp === 'number' &&
    Number.isFinite(item.timestamp) &&
    (item.delivery === undefined ||
      item.delivery === 'pending' ||
      item.delivery === 'submitting') &&
    Array.isArray(item.images) &&
    item.images.every(
      (image) => image && typeof image.data === 'string' && typeof image.mimeType === 'string'
    )
  );
}

export class QueuedMessageStorage {
  readonly key: string;
  private previous: string | null = null;
  private loaded = false;

  constructor(
    private storage: QueueStorage,
    readonly sessionId: string
  ) {
    this.key = `codepro-queue:v1:${encodeURIComponent(sessionId)}`;
  }

  read(): StoredQueuedMessage[] {
    const raw = this.storage.getItem(this.key);
    if (raw === null) {
      this.previous = null;
      this.loaded = true;
      return [];
    }
    const parsed = JSON.parse(raw) as QueueSnapshot;
    if (
      parsed.version !== 1 ||
      parsed.sessionId !== this.sessionId ||
      typeof parsed.revision !== 'string' ||
      !Array.isArray(parsed.messages) ||
      !parsed.messages.every(isMessage) ||
      new Set(parsed.messages.map((item) => item.id)).size !== parsed.messages.length
    ) {
      throw new Error('Invalid queue snapshot');
    }
    this.previous = raw;
    this.loaded = true;
    return parsed.messages.map(({ presentation, queuedWhileBusy, ...message }) => {
      const restored = {
        ...message,
        ...(queuedWhileBusy === true ? { queuedWhileBusy: true as const } : {}),
      };
      return typeof presentation?.afterMessageId === 'string' &&
      presentation.afterMessageId.length > 0 &&
      presentation.afterMessageId.length <= 2048 &&
      presentation.afterMessageId !== message.id
        ? { ...restored, presentation: { afterMessageId: presentation.afterMessageId } }
        : restored;
    });
  }

  write(messages: StoredQueuedMessage[]): void {
    if (!this.loaded) throw new Error('Queue snapshot has not been loaded');
    // Detect a stale writer; this check is not an atomic cross-window compare-and-swap.
    if (this.storage.getItem(this.key) !== this.previous) {
      throw new QueueStorageConflict('The saved queue changed in another window');
    }
    const raw = JSON.stringify({
      version: 1,
      sessionId: this.sessionId,
      revision: window.crypto.randomUUID(),
      messages,
    } satisfies QueueSnapshot);
    this.storage.setItem(this.key, raw);
    this.previous = raw;
  }

  isCurrent(): boolean {
    return this.loaded && this.storage.getItem(this.key) === this.previous;
  }
}
