import {
  invalid,
  requireString,
  driverProvider,
  providerStatus,
  modelBase,
} from "./providers.mjs";
import { protectSecret, revealSecret } from "./secrets.mjs";
import { validateWave } from "./harness/node_modules/@deepseek-ai/dsh-experimental-speech-to-text/lib/types/wave.js";

const prefix = "_goose/unstable/";
const definitions = {
  openai: {
    key: "OPENAI_API_KEY",
    modelKey: "OPENAI_TRANSCRIPTION_MODEL",
    model: "whisper-1",
    modelLabel: "Whisper-1",
    modelField: "model",
    endpoint: "https://api.openai.com/v1/audio/transcriptions",
    usesProviderConfig: true,
    description: "Uses the configured OpenAI transcription connection.",
  },
  groq: {
    key: "GROQ_API_KEY",
    modelKey: "GROQ_TRANSCRIPTION_MODEL",
    model: "whisper-large-v3-turbo",
    modelLabel: "Whisper Large V3 Turbo",
    modelField: "model",
    endpoint: "https://api.groq.com/openai/v1/audio/transcriptions",
    description: "Uses the configured Groq speech-to-text service.",
  },
  elevenlabs: {
    key: "ELEVENLABS_API_KEY",
    modelKey: "ELEVENLABS_TRANSCRIPTION_MODEL",
    model: "scribe_v2",
    modelLabel: "Scribe v2",
    modelField: "model_id",
    endpoint: "https://api.elevenlabs.io/v1/speech-to-text",
    description: "Uses the configured ElevenLabs speech-to-text service.",
  },
};
const mimeExtensions = new Map([
  ["audio/webm", "webm"],
  ["audio/webm;codecs=opus", "webm"],
  ["audio/mp4", "mp4"],
  ["audio/mpeg", "mp3"],
  ["audio/mpga", "mp3"],
  ["audio/m4a", "m4a"],
  ["audio/wav", "wav"],
  ["audio/x-wav", "wav"],
]);
const methodName = (name) =>
  name.startsWith(prefix) ? name.slice(prefix.length) : name;
const methods = new Set([
  "dictation/config",
  "dictation/transcribe",
  "dictation/secret/save",
  "dictation/secret/delete",
]);

function providerDefinition(provider) {
  if (provider === "local")
    throw invalid("Local speech recognition is not connected to this build", {
      reason: "local_dictation_unavailable",
    });
  if (typeof provider !== "string" || !Object.hasOwn(definitions, provider))
    throw invalid("Unknown dictation provider");
  return definitions[provider];
}

function validEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw invalid("Configure a valid dictation service URL");
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash
  )
    throw invalid(
      "Dictation service URL must use HTTP(S) without embedded credentials or fragments",
    );
  return endpoint;
}

/** Preserve gateway prefixes and queries, matching the original OpenAI adapter. */
export function transcriptionEndpoint(baseUrl) {
  const endpoint = validEndpoint(baseUrl);
  const pathname = endpoint.pathname.replace(/\/+$/u, "");
  if (!pathname) endpoint.pathname = "/v1/audio/transcriptions";
  else if (!pathname.endsWith("/audio/transcriptions"))
    endpoint.pathname = pathname + "/audio/transcriptions";
  return endpoint;
}

function modelFor(state, def) {
  const configured = state.config?.[def.modelKey]?.value;
  if (configured == null || configured === "") return def.model;
  const model = requireString(configured, "Dictation model");
  if (model.length > 256 || /[\r\n\0]/u.test(model))
    throw invalid("Invalid dictation model");
  return model;
}

async function savedOpenAI(state, includeSecrets = true) {
  const legacy = state.config?.OPENAI_API_KEY?.secret;
  const baseUrl = state.config?.OPENAI_BASE_URL?.value;
  const host = state.config?.OPENAI_HOST?.value;
  let legacyBase = baseUrl || host;
  if (!baseUrl && host) {
    const endpoint = validEndpoint(host);
    endpoint.pathname = endpoint.pathname.replace(/\/+$/u, "") + "/v1";
    legacyBase = endpoint.href;
  }
  if (legacy || legacyBase)
    return {
      baseUrl: legacyBase || "https://api.openai.com/v1",
      apiKey: includeSecrets ? await revealSecret(legacy) : undefined,
      configured: Boolean(legacy),
    };
  // The dictation selector names OpenAI explicitly; never borrow an unrelated
  // active connection or send that connection's credentials to a default origin.
  const candidates = (state.providers ?? []).filter(
    (row) => row.id === "openai" || row.catalogProviderId === "openai",
  );
  const selected =
    candidates.find((row) => row.id === state.defaults?.providerId) ??
    (candidates.length === 1 ? candidates[0] : undefined);
  if (!selected) return undefined;
  return {
    ...(includeSecrets
      ? await driverProvider(selected)
      : { baseUrl: modelBase(selected) }),
    configured: providerStatus(selected).isConfigured,
  };
}

async function boundedJson(response, maxBytes) {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) {
    await response.body?.cancel();
    throw invalid("Dictation service response is too large");
  }
  const chunks = [];
  let size = 0;
  if (!response.body)
    throw invalid("Dictation service returned an empty response");
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxBytes)
      throw invalid("Dictation service response is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch {
    throw invalid("Dictation service returned invalid JSON");
  }
}

export class TranscriptionService {
  constructor(
    store,
    {
      resolveOpenAI,
      fetch = globalThis.fetch,
      timeoutMs = 30_000,
      maxAudioBytes = 50 * 1024 * 1024,
      maxResponseBytes = 1024 * 1024,
    } = {},
  ) {
    this.store = store;
    this.resolveOpenAI =
      resolveOpenAI ??
      (({ includeSecrets } = {}) =>
        savedOpenAI(this.store.read(), includeSecrets));
    this.fetch = fetch;
    this.timeoutMs = timeoutMs;
    this.maxAudioBytes = maxAudioBytes;
    this.maxResponseBytes = maxResponseBytes;
    this.active = new Set();
    this.closed = false;
  }

  handles(name) {
    return methods.has(methodName(name));
  }
  disconnect(connection) {
    for (const row of this.active)
      if (row.connection === connection) row.controller.abort();
  }
  close() {
    this.closed = true;
    for (const row of this.active) row.controller.abort();
  }

  async connection(provider, includeSecrets = true) {
    const def = providerDefinition(provider);
    if (provider === "openai") {
      const configured = await this.resolveOpenAI({ includeSecrets });
      if (!configured) return { configured: false };
      const endpoint = transcriptionEndpoint(configured.baseUrl);
      return {
        ...configured,
        endpoint,
        configured:
          configured.configured ??
          Boolean(configured.apiKey || configured.headers?.Authorization),
      };
    }
    const secret = this.store.read().config?.[def.key]?.secret;
    return {
      endpoint: new URL(def.endpoint),
      apiKey: includeSecrets ? await revealSecret(secret) : undefined,
      configured: Boolean(secret),
    };
  }

  async config() {
    const state = this.store.read();
    const providers = {};
    for (const [name, def] of Object.entries(definitions)) {
      const configured = await this.connection(name, false);
      providers[name] = {
        configured: configured.configured,
        host: configured.endpoint
          ? configured.endpoint.origin +
            configured.endpoint.pathname.replace(
              /\/(?:audio\/transcriptions|speech-to-text)$/u,
              "",
            )
          : null,
        description: def.description,
        usesProviderConfig: Boolean(def.usesProviderConfig),
        settingsPath: def.usesProviderConfig ? "Settings > Models" : null,
        configKey: def.usesProviderConfig ? null : def.key,
        modelConfigKey: def.modelKey,
        defaultModel: def.model,
        selectedModel: modelFor(state, def),
        availableModels: [
          {
            id: def.model,
            label: def.modelLabel,
            description: def.description,
          },
        ],
      };
    }
    return { providers };
  }

  audio(params) {
    const extension = mimeExtensions.get(params.mimeType);
    if (!extension) throw invalid("Unsupported dictation audio MIME type");
    if (
      typeof params.audio !== "string" ||
      !params.audio.length ||
      params.audio.length > 4 * Math.ceil(this.maxAudioBytes / 3)
    )
      throw invalid("Dictation audio is empty or exceeds the size limit");
    if (params.audio.length % 4 !== 0 || /[^A-Za-z0-9+/=]/u.test(params.audio))
      throw invalid("Invalid base64 dictation audio");
    const bytes = Buffer.from(params.audio, "base64");
    if (
      !bytes.length ||
      bytes.length > this.maxAudioBytes ||
      bytes.toString("base64") !== params.audio
    )
      throw invalid("Invalid or oversized dictation audio");
    if (extension === "wav") {
      try {
        validateWave(bytes, this.maxAudioBytes / 32000);
      } catch {
        throw invalid("Dictation WAV must be complete 16 kHz mono PCM16 audio");
      }
    }
    return { bytes, extension };
  }

  async transcribe(params, connection) {
    const def = providerDefinition(params.provider);
    const { bytes, extension } = this.audio(params);
    if (this.active.size >= 4)
      throw invalid(
        "Too many active dictation requests; wait for an earlier recording",
      );
    const controller = new AbortController();
    const row = { controller, connection };
    this.active.add(row);
    const timer = setTimeout(() => controller.abort("timeout"), this.timeoutMs);
    try {
      const target = await this.connection(params.provider);
      if (!target.configured)
        throw invalid(
          "Configure the selected dictation provider before recording",
          { reason: "dictation_not_configured" },
        );
      controller.signal.throwIfAborted();
      const form = new FormData();
      form.append(
        "file",
        new Blob([bytes], { type: params.mimeType }),
        `audio.${extension}`,
      );
      form.append(def.modelField, modelFor(this.store.read(), def));
      const headers = new Headers(target.headers ?? {});
      headers.delete("content-type");
      headers.delete("content-length");
      headers.set("accept", "application/json");
      if (target.apiKey)
        headers.set(
          params.provider === "elevenlabs" ? "xi-api-key" : "authorization",
          params.provider === "elevenlabs"
            ? target.apiKey
            : `Bearer ${target.apiKey}`,
        );
      const response = await this.fetch(target.endpoint, {
        method: "POST",
        headers,
        body: form,
        redirect: "manual",
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        const reason =
          response.status === 401 || response.status === 403
            ? "dictation_authentication_failed"
            : response.status === 429
              ? "dictation_rate_limited"
              : "dictation_service_error";
        throw invalid(`Dictation service returned HTTP ${response.status}`, {
          reason,
          status: response.status,
        });
      }
      const result = await boundedJson(response, this.maxResponseBytes);
      if (typeof result?.text !== "string")
        throw invalid("Dictation service response is missing text");
      return { text: result.text };
    } catch (error) {
      if (controller.signal.aborted)
        throw invalid(
          controller.signal.reason === "timeout"
            ? "Dictation request timed out"
            : "Dictation request was cancelled",
          {
            reason:
              controller.signal.reason === "timeout"
                ? "dictation_timeout"
                : "dictation_cancelled",
          },
        );
      if (error.code === -32602) throw error;
      // Upstream response bodies, URLs, headers and transport causes can contain
      // credentials or transcript text. Keep those out of RPC errors and logs.
      throw invalid("Dictation service request failed", {
        reason: "dictation_request_failed",
      });
    } finally {
      clearTimeout(timer);
      this.active.delete(row);
    }
  }

  async request(name, params = {}, connection) {
    const method = methodName(name);
    if (!methods.has(method)) return undefined;
    if (this.closed) throw invalid("Dictation service is closed");
    if (method === "dictation/config") return this.config();
    if (method === "dictation/transcribe")
      return this.transcribe(params, connection);
    const def = providerDefinition(params.provider);
    if (def.usesProviderConfig)
      throw invalid("Configure OpenAI credentials in model provider settings");
    if (method === "dictation/secret/save") {
      const value = requireString(params.value, "Dictation API key");
      if (value.length > 16384 || /[\r\n\0]/u.test(value))
        throw invalid("Invalid dictation API key");
      const secret = await protectSecret(value);
      await this.store.update((state) => {
        state.config[def.key] = { secret };
      });
    } else
      await this.store.update((state) => {
        delete state.config[def.key];
      });
    return {};
  }
}
