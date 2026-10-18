import { randomUUID, createHash } from "node:crypto";
import { protectSecret, revealSecret } from "./secrets.mjs";
import { DEFAULT_CONTEXT_WINDOW } from "./model-defaults.mjs";
import { catalogModels } from './harness/model-catalog.mjs';

const RESPONSE_LIMIT = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
// Advisory model metadata is shared across sessions, never fetched per turn.
// The connection fingerprint invalidates it when endpoint or credentials change.
const modelListings = new Map();
const metadataTtlMs = 5 * 60_000;
function listingKey(provider) {
  return createHash('sha256').update(JSON.stringify([endpoints(provider).discovery.href,
    provider.engine, provider.catalogProviderId, provider.secret, provider.headersProtected, provider.apiKey, provider.headers])).digest('hex');
}
function modelContext(model) {
  return [model?.max_model_len, model?.contextWindow, model?.context_window, model?.context_length, model?.max_input_tokens, model?.limit?.context].find(value => Number.isSafeInteger(value) && value > 0);
}
function modelImageProfile(model, source = 'provider_metadata') {
  const input = model?.inputModalities ?? model?.input ?? model?.input_modalities ?? model?.architecture?.input_modalities;
  if (!Array.isArray(input) || !input.length || !input.every(value => typeof value === 'string')) return undefined;
  return { imageInput: input.includes('image') ? 'supported' : 'unsupported', source };
}
export function contextProfile(provider, model) {
  const discovered = cachedModels(provider)?.contexts?.[model];
  const configured = provider.contextWindows?.[model];
  if (Number.isSafeInteger(configured) && configured > 0)
    return { contextWindow: discovered ? Math.min(configured, discovered) : configured, contextSource: discovered && discovered < configured ? (cachedModels(provider)?.sources?.[model] ?? 'service') : 'configured' };
  return { contextWindow: discovered ?? DEFAULT_CONTEXT_WINDOW, contextSource: discovered ? (cachedModels(provider)?.sources?.[model] ?? 'service') : 'fallback' };
}
function cachedModels(provider) {
  const cached = modelListings.get(listingKey(provider));
  return cached && cached.expires > Date.now() ? cached : undefined;
}

export function invalid(message, data) {
  return Object.assign(new Error(message), { code: -32602, data });
}

function providerError(code, message) {
  return invalid(message, { code: `custom_provider_${code}`, message });
}

export function requireString(value, name) {
  if (typeof value !== "string" || !value.trim())
    throw invalid(`${name} must be a nonempty string`);
  return value.trim();
}

export function modelIds(models) {
  if (!Array.isArray(models)) throw invalid("models must be an array");
  return [
    ...new Set(
      models
        .map((model) => (typeof model === "string" ? model : model?.id))
        .filter((model) => typeof model === "string" && model.trim())
        .map((model) => model.trim()),
    ),
  ];
}

function engineName(engine) {
  if (engine === "openai" || engine === "openai_compatible")
    return "openai_compatible";
  if (engine === "ollama" || engine === "ollama_compatible")
    return "ollama_compatible";
  throw providerError(
    "unsupported_engine",
    "This preview supports OpenAI-compatible and Ollama model connections.",
  );
}

function endpoints(provider) {
  const engine = engineName(provider.engine);
  let parsed;
  try {
    parsed = new URL(requireString(provider.apiUrl, "apiUrl"));
  } catch {
    throw providerError(
      "invalid_url",
      "Enter a valid HTTP or HTTPS model endpoint.",
    );
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw providerError(
      "invalid_url",
      "Use an HTTP(S) endpoint without credentials, query parameters, or fragments.",
    );
  }
  if (provider.basePath != null && typeof provider.basePath !== "string")
    throw invalid("basePath must be a string");
  const configuredPath = provider.basePath?.trim() || parsed.pathname;
  if (/[?#\\]/.test(configuredPath) || configuredPath.includes("://")) {
    throw providerError(
      "invalid_url",
      "The API base path must be a path without query parameters or fragments.",
    );
  }
  const pathname = configuredPath.replace(/^\/+|\/+$/g, "");
  const append = (suffix) =>
    pathname ? `/${pathname}/${suffix}` : `/${suffix}`;
  const completionPath = /(?:chat\/completions|responses)$/.test(pathname)
    ? `/${pathname}`
    : pathname.endsWith("v1")
      ? append("chat/completions")
      : append("v1/chat/completions");
  const discoveryPath =
    engine === "ollama_compatible"
      ? pathname.endsWith("api")
        ? append("tags")
        : "/api/tags"
      : pathname.endsWith("chat/completions")
        ? `/${pathname.replace(/chat\/completions$/, "models")}`
        : pathname.endsWith("responses")
          ? `/${pathname.replace(/responses$/, "models")}`
          : pathname.endsWith("v1")
            ? append("models")
            : append("v1/models");
  const completion = new URL(parsed);
  completion.pathname = completionPath;
  const discovery = new URL(parsed);
  discovery.pathname = discoveryPath;
  return { completion, discovery, engine };
}

export function modelBase(provider) {
  return endpoints(provider)
    .completion.toString()
    .replace(/\/(?:chat\/completions|responses)$/, "");
}

function sameConnection(first, second) {
  if (!first || !second) return false;
  try {
    const a = endpoints(first);
    const b = endpoints(second);
    return a.engine === b.engine && a.completion.href === b.completion.href;
  } catch {
    return false;
  }
}

function normalizedHeaders(input) {
  if (input == null) return {};
  if (typeof input !== "object" || Array.isArray(input))
    throw invalid("headers must be an object");
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string")
      throw providerError("invalid_header", "Header values must be strings.");
    const name = key.trim();
    if (!name) continue;
    try {
      new Headers({ [name]: value.trim() });
    } catch {
      throw providerError(
        "invalid_header",
        "A custom header name or value is invalid.",
      );
    }
    result[name] = value.trim();
  }
  return result;
}

async function storedHeaders(provider) {
  if (!provider) return {};
  if (provider.headersProtected)
    return normalizedHeaders(
      JSON.parse(await revealSecret(provider.headersProtected)),
    );
  return normalizedHeaders(provider.headers);
}

async function credentials(input, stored) {
  const reusable = sameConnection(input, stored);
  const key =
    typeof input.apiKey === "string" && input.apiKey.trim()
      ? input.apiKey.trim()
      : reusable
        ? await revealSecret(stored.secret)
        : "";
  const customHeaders =
    input.headers != null
      ? normalizedHeaders(input.headers)
      : reusable
        ? await storedHeaders(stored)
        : {};
  const requiresAuth = input.requiresAuth ?? stored?.requiresAuth ?? true;
  if (typeof requiresAuth !== "boolean")
    throw invalid("requiresAuth must be a boolean");
  if (requiresAuth && !key)
    throw providerError(
      "api_key_required",
      "An API key is required for this connection.",
    );
  const requestHeaders = new Headers(customHeaders);
  if (key && !requestHeaders.has("authorization"))
    requestHeaders.set("Authorization", `Bearer ${key}`);
  return { key, customHeaders, requestHeaders, requiresAuth };
}

async function requestJson(
  url,
  { headers, method = "GET", payload, models = false, timeoutMs = REQUEST_TIMEOUT_MS },
) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
  } catch {
    throw providerError(
      "endpoint_unreachable",
      "Could not reach the model endpoint.",
    );
  }
  if ([401, 403].includes(response.status)) {
    await response.body?.cancel();
    throw providerError("invalid_credentials", "The API key was rejected.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw providerError(
      models ? "model_list_unavailable" : "model_unavailable",
      models
        ? "The model list could not be loaded from this address."
        : "The selected model could not complete a test request.",
    );
  }
  if (Number(response.headers.get("content-length")) > RESPONSE_LIMIT) {
    await response.body?.cancel();
    throw providerError(
      "response_too_large",
      "The model endpoint returned too much data.",
    );
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > RESPONSE_LIMIT)
        throw providerError(
          "response_too_large",
          "The model endpoint returned too much data.",
        );
      chunks.push(chunk);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw providerError(
        "invalid_response",
        "The model endpoint did not return a JSON object.",
      );
    }
    return parsed;
  } catch (error) {
    if (error?.data?.code) throw error;
    throw providerError(
      "invalid_response",
      "The model endpoint did not return valid JSON.",
    );
  }
}

export async function discover(input, stored, { timeoutMs, authPending } = {}) {
  const provider = { ...stored, ...input };
  const endpoint = endpoints(provider);
  const auth = await (authPending ?? credentials(
    provider,
    stored ?? (provider.secret ? provider : null),
  ));
  const body = await requestJson(endpoint.discovery, {
    headers: auth.requestHeaders,
    models: true,
    timeoutMs,
  });
  const rawModels =
    endpoint.engine === "ollama_compatible"
      ? body.models?.map((model) => model?.name)
      : body.data;
  if (!Array.isArray(rawModels))
    throw providerError(
      "invalid_response",
      "The model endpoint did not return a model list.",
    );
  const ids = modelIds(rawModels);
  if (!ids.length)
    throw providerError("no_models", "The model endpoint returned no models.");
  const contexts = Object.fromEntries(rawModels.filter(model => modelContext(model) !== undefined)
    .map(model => [model.id, modelContext(model)]));
  const inputs = Object.fromEntries(rawModels.filter(model => modelImageProfile(model))
    .map(model => [model.id, modelImageProfile(model)]));
  modelListings.set(listingKey(provider), { contexts, inputs, expires: Date.now() + metadataTtlMs });
  return ids;
}

async function resolveContext(provider, model, authPending) {
  if (!model) return undefined;
  const key = listingKey(provider);
  let cached = cachedModels(provider);
  if (!cached) {
    cached = { expires: Date.now() + metadataTtlMs };
    modelListings.set(key, cached);
    cached.pending = discover(provider, provider, { timeoutMs: 2000, authPending }).catch(() => {
      // A missing/offline catalog must not prevent a working completion route.
      modelListings.set(key, { contexts: {}, expires: Date.now() + 30_000 });
    });
  }
  await cached.pending;
  cached = cachedModels(provider);
  if (cached && (!cached.contexts?.[model] || !cached.inputs?.[model])) {
    cached.details ??= new Map();
    if (!cached.details.has(model)) cached.details.set(model, (async () => {
      try {
        let capacity, source;
        const base = new URL(provider.apiUrl);
        // Cloud uses its full window. Local model_info is only an architectural
        // maximum, not the running num_ctx; never adopt it as deployment capacity.
        if (base.protocol === 'https:' && base.hostname === 'ollama.com') {
          const auth = await (authPending ?? credentials(provider, provider));
          const body = await requestJson(new URL('/api/show', base), { method: 'POST', headers: auth.requestHeaders,
            payload: { model }, timeoutMs: 5000 });
          capacity = Object.entries(body.model_info ?? {}).find(([k, v]) => k.endsWith('.context_length') && Number.isSafeInteger(v) && v > 0)?.[1];
          if (Array.isArray(body.capabilities) && body.capabilities.length && body.capabilities.every(value => typeof value === 'string')) {
            cached.inputs ??= {};
            cached.inputs[model] = { imageInput: body.capabilities.includes('vision') ? 'supported' : 'unsupported', source: 'provider_metadata' };
          }
          source = 'service';
        }
        if (!capacity && provider.catalogProviderId) {
          const info = (await catalogModels(provider.catalogProviderId)).find(m => m.id === model);
          capacity = info?.contextWindow;
          const input = modelImageProfile(info, 'catalog');
          if (input && !cached.inputs?.[model]) { cached.inputs ??= {}; cached.inputs[model] = input; }
          source = 'catalog';
        }
        if (capacity) {
          cached.contexts ??= {}; cached.sources ??= {};
          cached.contexts[model] = capacity; cached.sources[model] = source;
        }
      } catch { /* Advisory metadata must not disable a working model route. */ }
    })());
    await cached.details.get(model);
  }
  return cachedModels(provider)?.contexts?.[model];
}

export async function resolveImageCapability(provider, model) {
  await resolveContext(provider, model);
  return cachedModels(provider)?.inputs?.[model] ?? { imageInput: 'unknown', source: 'unknown' };
}

async function validateSelection(provider, stored) {
  const available = await discover(provider, stored);
  if (
    !provider.models.length ||
    !provider.models.every((model) => available.includes(model))
  ) {
    throw providerError(
      "model_unavailable",
      "One or more selected models are not available from this connection.",
    );
  }
  const { completion } = endpoints(provider);
  const auth = await credentials(provider, stored);
  auth.requestHeaders.set("Content-Type", "application/json");
  const responses = completion.pathname.endsWith("/responses");
  const payload = responses
    ? {
        model: provider.models[0],
        input: "Reply OK.",
        max_output_tokens: 1,
        stream: false,
      }
    : {
        model: provider.models[0],
        messages: [{ role: "user", content: "Reply OK." }],
        max_tokens: 1,
        stream: false,
      };
  const body = await requestJson(completion, {
    headers: auth.requestHeaders,
    method: "POST",
    payload,
  });
  const completed = responses
    ? (Array.isArray(body.output) && body.output.length > 0) ||
      typeof body.output_text === "string"
    : Array.isArray(body.choices) && body.choices.length > 0;
  if (!completed)
    throw providerError(
      "model_unavailable",
      "The selected model did not return a usable response.",
    );
  return auth;
}

export async function saveProvider(store, input, update = false) {
  const current = update
    ? store
        .read()
        .providers.find((provider) => provider.id === input.providerId)
    : null;
  if (update && !current) throw invalid("Provider not found");
  if (input.basePath != null && typeof input.basePath !== "string")
    throw invalid("basePath must be a string");
  const provider = {
    id: current?.id ?? `custom_${randomUUID()}`,
    engine: engineName(input.engine),
    displayName: requireString(input.displayName, "displayName"),
    apiUrl: requireString(input.apiUrl, "apiUrl"),
    basePath: input.basePath?.trim() || null,
    requiresAuth: input.requiresAuth ?? true,
    models: modelIds(input.models ?? current?.models ?? []),
    ...(current?.contextWindows ? { contextWindows: current.contextWindows } : {}),
    supportsStreaming:
      input.supportsStreaming ?? current?.supportsStreaming ?? true,
    catalogProviderId:
      input.catalogProviderId ?? current?.catalogProviderId ?? null,
    preservesThinking:
      input.preservesThinking ?? current?.preservesThinking ?? false,
  };
  endpoints(provider);
  const auth = await validateSelection(
    { ...provider, apiKey: input.apiKey, headers: input.headers },
    current,
  );
  provider.secret = await protectSecret(auth.key);
  provider.headersProtected = Object.keys(auth.customHeaders).length
    ? await protectSecret(JSON.stringify(auth.customHeaders))
    : null;
  await store.update((state) => {
    const index = state.providers.findIndex((item) => item.id === provider.id);
    if (index < 0) state.providers.push(provider);
    else state.providers[index] = provider;
  });
  return {
    providerId: provider.id,
    status: providerStatus(provider),
    refresh: { started: [] },
  };
}

export function providerStatus(provider) {
  return {
    providerId: provider.id,
    isConfigured: !provider.requiresAuth || Boolean(provider.secret),
  };
}

export function inventory(provider) {
  return {
    providerId: provider.id,
    providerName: provider.displayName,
    description: "Model connection used by CodeBuddy",
    defaultModel: provider.models[0] ?? "",
    configured: providerStatus(provider).isConfigured,
    providerType: "Custom",
    category: "model",
    configKeys: [],
    setupSteps: [],
    supportsRefresh: true,
    refreshing: false,
    models: provider.models.map((id) => ({
      id,
      name: id,
      contextLimit: contextProfile(provider, id).contextWindow,
    })),
    stale: false,
  };
}

export async function resolvedModelInfo(provider, model) {
  if (!provider.models.includes(model)) throw invalid('Unknown model for this provider');
  if (providerStatus(provider).isConfigured) await resolveContext(provider, model);
  const profile = contextProfile(provider, model);
  return { provider: provider.id, model, contextLimit: profile.contextWindow,
    contextSource: profile.contextSource, reasoning: false, currency: 'USD' };
}

export async function resolvedInventory(provider) {
  // The initial desktop model list precedes session creation. Resolve through
  // the same bounded cache so the homepage and executor share capacity.
  if (providerStatus(provider).isConfigured) await resolveContext(provider, provider.models[0]);
  return inventory(provider);
}

export async function readProvider(provider) {
  return {
    provider: {
      providerId: provider.id,
      engine: provider.engine,
      displayName: provider.displayName,
      apiUrl: provider.apiUrl,
      models: provider.models,
      supportsStreaming: provider.supportsStreaming ?? true,
      headers: await storedHeaders(provider),
      requiresAuth: provider.requiresAuth,
      catalogProviderId: provider.catalogProviderId ?? null,
      basePath: provider.basePath ?? null,
      apiKeyEnv: null,
      apiKeySet: Boolean(provider.secret),
      preservesThinking: provider.preservesThinking ?? false,
    },
    editable: true,
    status: providerStatus(provider),
  };
}

export async function driverProvider(provider, model) {
  const authPending = credentials(provider, provider);
  const [auth] = await Promise.all([authPending, resolveContext(provider, model, authPending)]);
  const { key: apiKey, customHeaders: headers } = auth;
  return {
    id: provider.id,
    baseUrl: modelBase(provider),
    apiKey,
    headers,
    // Gemma 4 chat templates expose a boolean switch, not reasoning_effort.
    // The official Harness/pi-ai adapter owns serialization and streaming.
    ...(/^gemma-?4(?:[-:]|$)/i.test(model?.split('/').at(-1) ?? '') ? {
      compat: { thinkingFormat: 'chat-template', chatTemplateKwargs: { enable_thinking: { $var: 'thinking.enabled' } }, supportsDeveloperRole: false },
      reasoningEfforts: { off: null, minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'high' },
    } : {}),
    ...contextProfile(provider, model),
    protocol: endpoints(provider).completion.pathname.endsWith("/responses")
      ? "openai-responses"
      : "openai-completions",
  };
}
