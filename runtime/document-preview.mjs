import { Context } from "./harness/node_modules/@deepseek-ai/cordis/lib/index.js";
import OfficeToPdf, {
  OfficeSourceKey,
} from "./harness/node_modules/@deepseek-ai/dsh-office-to-pdf/lib/index.js";

// Desktop owns authorization and versioned bounded reads. The official service
// owns conversion admission, reuse, cancellation and private scratch cleanup.
export class DocumentPreviewer {
  #context;
  #lifetime = new AbortController();

  async render(source, signal) {
    const active = AbortSignal.any([signal, this.#lifetime.signal]);
    active.throwIfAborted();
    if (source.extension === ".pdf" || source.extension === ".xlsx") {
      const { bytes, version } = await source.read(
        active,
        source.extension === ".xlsx" ? 16 * 1024 * 1024 : 32 * 1024 * 1024,
      );
      active.throwIfAborted();
      if (version !== source.version)
        throw new Error("Document changed; reload its preview");
      return {
        kind: source.extension === ".xlsx" ? "excel" : "pdf",
        data: bytes,
        missingFonts: [],
      };
    }
    if (![".docx", ".pptx"].includes(source.extension))
      throw new Error("Unsupported document format");
    this.#context ??= (async () => {
      const ctx = new Context();
      try {
        await ctx.plugin(OfficeToPdf, {
          maxConcurrentConversions: 1,
          maxBackgroundConversions: 0,
          maxInputBytes: 32 * 1024 * 1024,
          maxSourceBytes: 32 * 1024 * 1024,
          maxOutputBytes: 64 * 1024 * 1024,
          maxCachedBytes: 96 * 1024 * 1024,
        });
        return ctx;
      } catch (error) {
        await ctx.fiber.dispose();
        this.#context = undefined;
        throw error;
      }
    })();
    const ctx = await this.#context;
    active.throwIfAborted();
    const result = await ctx.officeToPdf.convert(
      {
        extension: source.extension.slice(1),
        priority: "foreground",
        source: {
          key: OfficeSourceKey(source.key),
          version: source.version,
          bytes: source.size,
          read: source.read,
        },
      },
      active,
    );
    return { kind: "pdf", data: result.pdf, missingFonts: result.missingFonts };
  }

  async dispose() {
    this.#lifetime.abort();
    await (await this.#context)?.fiber.dispose();
  }
}
