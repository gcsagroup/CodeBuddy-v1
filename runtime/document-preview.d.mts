export interface DocumentSource {
  key: string;
  extension: string;
  version: string;
  size: number;
  read(
    signal: AbortSignal,
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array; version: string }>;
}
export class DocumentPreviewer {
  render(
    source: DocumentSource,
    signal: AbortSignal,
  ): Promise<{
    kind: "pdf" | "excel";
    data: Uint8Array;
    missingFonts: string[];
  }>;
  dispose(): Promise<void>;
}
