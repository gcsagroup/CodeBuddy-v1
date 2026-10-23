export interface ToolInputPreview {
  id: string;
  name: string;
  path?: string;
  kilobytes?: number;
}

// Optional display metadata must not turn a malformed preview into a failed turn.
export function parseToolInputPreview(value: unknown): ToolInputPreview | undefined {
  if (!value || typeof value !== 'object') return;
  const preview = value as Record<string, unknown>;
  if (
    typeof preview.id !== 'string' ||
    !preview.id ||
    preview.id.length > 256 ||
    typeof preview.name !== 'string' ||
    !preview.name ||
    preview.name.length > 256
  )
    return;
  return {
    id: preview.id,
    name: preview.name,
    ...(typeof preview.path === 'string' && preview.path.length <= 4096
      ? { path: preview.path }
      : {}),
    ...(Number.isSafeInteger(preview.kilobytes) && Number(preview.kilobytes) >= 0
      ? { kilobytes: Number(preview.kilobytes) }
      : {}),
  };
}
