export async function safeJsonParse<T>(
  response: Response,
  errorMessage: string = 'Failed to parse server response'
): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(errorMessage);
    }
    throw error;
  }
}

export function errorMessage(err: Error | unknown, default_value?: string) {
  const acpData = acpErrorData(err);
  if (typeof acpData === 'string') {
    return acpData;
  }

  if (err instanceof Error) {
    return err.message;
  } else if (typeof err === 'object' && err !== null && 'message' in err) {
    return String(err.message);
  } else {
    return default_value || String(err);
  }
}

export function acpErrorData(err: unknown): unknown {
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }

  const candidate = 'error' in err && isRecord(err.error) ? err.error : err;
  return isRecord(candidate) ? candidate.data : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function formatErrorForLogging(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ''}`;
  }
  if (typeof error === 'object' && error !== null) {
    try {
      return JSON.stringify(error, null, 2);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

export async function compressImageDataUrl(dataUrl: string, preserveScreenshotDetail = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new globalThis.Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Failed to get canvas context'));
        return;
      }
      const longest = Math.max(img.width, img.height);
      // Keep text and thin field borders legible. Re-encode pixels to omit source metadata.
      const pngBudget = 4 * Math.ceil((1024 * 1024) / 3) + 'data:image/png;base64,'.length;
      if (preserveScreenshotDetail && dataUrl.startsWith('data:image/png;base64,') &&
          dataUrl.length <= pngBudget && longest <= 2560) {
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0);
        const png = canvas.toDataURL('image/png');
        if (png.startsWith('data:image/png;base64,') && png.length <= pngBudget) {
          resolve(png);
          return;
        }
      }
      const scale = Math.min(1, 1024 / longest);
      canvas.width = Math.max(1, Math.floor(img.width * scale));
      canvas.height = Math.max(1, Math.floor(img.height * scale));
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = dataUrl;
  });
}

export function formatAppName(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}
