import { randomUUID, createHash } from "node:crypto";
import { protectSecret, revealSecret } from "./secrets.mjs";
import { DEFAULT_CONTEXT_WINDOW } from "./model-defaults.mjs";
import { catalogModels, catalogThinkingProfile, catalogProviderForEndpoint, catalogModelIds } from './harness/model-catalog.mjs';

const RESPONSE_LIMIT = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const PROBE_OUTPUT_TOKENS = 128;
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
function modelOutput(model) {
  return [model?.maxOutputTokens, model?.max_output_tokens, model?.maxTokens, model?.max_tokens, model?.limit?.output, model?.top_provider?.max_completion_tokens].find(value => Number.isSafeInteger(value) && value > 0);
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

function providerError(code, message, details = {}) {
  return invalid(message, { code: `custom_provider_${code}`, message, ...details });
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
  const officialDefault = engine === 'openai_compatible' && parsed.origin === 'https://api.openai.com' &&
    !provider.basePath?.trim() && ['', 'v1'].includes(pathname);
  const completionPath = officialDefault ? '/v1/responses' : /(?:chat\/completions|responses)$/.test(pathname)
    ? `/${pathname}`
    : pathname.endsWith("v1")
      ? append("chat/completions")
      : append("v1/chat/completions");
  const discoveryPath =
    engine === "ollama_compatible" || parsed.protocol === 'https:' && parsed.hostname === 'ollama.com'
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

function providerCatalog(provider) {
  return provider.catalogProviderId ?? catalogProviderForEndpoint(modelBase(provider));
}

function orderedModels(provider, ids, created = {}) {
  const catalogProviderId = providerCatalog(provider);
  const catalog = new Set(catalogModelIds(catalogProviderId));
  // API entry creation can predate a newer model alias. Numbered GPT names
  // have a useful display order; this must never establish capabilities.
  const versions = new Map(ids.map(id => {
    const match = catalogProviderId === 'openai' && /^gpt-(\d+)(?:\.(\d+))?/.exec(id);
    return [id, match ? [Number(match[1]), Number(match[2] ?? 0)] : undefined];
  }));
  return [...ids].sort((a, b) => {
    const first = versions.get(a), second = versions.get(b);
    return Number(Boolean(second)) - Number(Boolean(first)) ||
      (first && second ? second[0] - first[0] || second[1] - first[1] : 0) ||
      Number(catalog.has(b)) - Number(catalog.has(a)) ||
      (created[b] ?? 0) - (created[a] ?? 0);
  });
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

async function providerFailureDetails(response) {
  const reader = response.body?.getReader();
  if (!reader) return {};
  try {
    const chunks = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8192) return {};
      chunks.push(value);
    }
    const error = JSON.parse(Buffer.concat(chunks).toString("utf8"))?.error;
    // Return only bounded protocol identifiers, never raw messages that can echo credentials.
    return Object.fromEntries([['upstreamCode', error?.code], ['upstreamParam', error?.param]]
      .filter(([, value]) => typeof value === 'string' && /^[a-zA-Z0-9_.[\]-]{1,100}$/.test(value)));
  } catch {
    return {};
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
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
  if (response.status === 401) {
    await response.body?.cancel();
    throw providerError("invalid_credentials", "The API key was rejected.", { httpStatus: 401 });
  }
  if (response.status === 403) {
    const details = await providerFailureDetails(response);
    throw providerError(
      "permission_denied",
      "The service denied access (HTTP 403). Check account permissions and service restrictions.",
      { httpStatus: response.status, ...details },
    );
  }
  if (!response.ok) {
    const details = await providerFailureDetails(response);
    const reason = [details.upstreamCode, details.upstreamParam].filter(Boolean).join(': ');
    throw providerError(
      models ? "model_list_unavailable" : "model_unavailable",
      (models
        ? `The model list could not be loaded from this address (HTTP ${response.status}).`
        : `The selected model could not complete a test request (HTTP ${response.status}).`) +
        (reason ? ` ${reason}` : '') + (!models && [400, 404, 422].includes(response.status)
          ? ' Check the API base path, selected model, tool support and thinking settings; loading the model list does not verify generation.' : ''),
      { httpStatus: response.status, ...details },
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
  const ollama = endpoint.discovery.pathname.endsWith('/api/tags');
  const rawModels = ollama ? body.models : body.data;
  if (!Array.isArray(rawModels))
    throw providerError(
      "invalid_response",
      "The model endpoint did not return a model list.",
    );
  const models = rawModels.map(model => ollama ? { ...model, id: model?.name } : model);
  const nonChatModels = ollama ? models.filter(model => Array.isArray(model?.capabilities) &&
    model.capabilities.length > 0 && model.capabilities.every(value => typeof value === 'string') &&
    !model.capabilities.includes('completion')).map(model => model.id) : [];
  const ids = modelIds(models).filter(id => !nonChatModels.includes(id));
  if (!ids.length && !nonChatModels.length)
    throw providerError("no_models", "The model endpoint returned no chat models.");
  const contexts = Object.fromEntries(models.filter(model => modelContext(model) !== undefined)
    .map(model => [model.id, modelContext(model)]));
  const inputs = Object.fromEntries(models.filter(model => modelImageProfile(model))
    .map(model => [model.id, modelImageProfile(model)]));
  const outputs = Object.fromEntries(models.filter(model => modelOutput(model) !== undefined)
    .map(model => [model.id, modelOutput(model)]));
  const templateBackends = Object.fromEntries(models.filter(model => ['vllm', 'sglang'].includes(model?.owned_by))
    .map(model => [model.id, model.owned_by]));
  const created = Object.fromEntries(models.filter(model => Number.isSafeInteger(model?.created) && model.created > 0)
    .map(model => [model.id, model.created]));
  modelListings.set(listingKey(provider), { contexts, inputs, outputs, nonChatModels, templateBackends, created, expires: Date.now() + metadataTtlMs });
  return orderedModels(provider, ids, created);
}

async function resolveContext(provider, model, authPending, retryAfterRefresh = true) {
  if (!model) return undefined;
  const catalogProviderId = providerCatalog(provider);
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
  if (cached && (!cached.contexts?.[model] || !cached.inputs?.[model] || !cached.outputs?.[model] || !Object.hasOwn(cached.thinking ?? {}, model))) {
    cached.details ??= new Map();
    if (!cached.details.has(model)) cached.details.set(model, (async () => {
      try {
        let capacity, source;
        const base = new URL(provider.apiUrl);
        if (Object.hasOwn(cached.templateBackends ?? {}, model) && endpoints(provider).completion.pathname.endsWith('/chat/completions')) {
          const auth = await (authPending ?? credentials(provider, provider));
          cached.thinking ??= {};
          cached.thinking[model] = await templateThinkingProfile(provider, model, auth.requestHeaders, cached.templateBackends[model]);
        }
        // Cloud uses its full window. Local model_info is only an architectural
        // maximum, not the running num_ctx; never adopt it as deployment capacity.
        if (base.protocol === 'https:' && base.hostname === 'ollama.com' || engineName(provider.engine) === 'ollama_compatible') {
          const auth = await (authPending ?? credentials(provider, provider));
          const body = await requestJson(new URL('/api/show', base), { method: 'POST', headers: auth.requestHeaders,
            payload: { model }, timeoutMs: 5000 });
          if (base.protocol === 'https:' && base.hostname === 'ollama.com')
            capacity = Object.entries(body.model_info ?? {}).find(([k, v]) => k.endsWith('.context_length') && Number.isSafeInteger(v) && v > 0)?.[1];
          cached.thinking ??= {};
          cached.thinking[model] = ollamaThinkingProfile(body);
          if (Array.isArray(body.capabilities) && body.capabilities.length && body.capabilities.every(value => typeof value === 'string')) {
            cached.inputs ??= {};
            cached.inputs[model] = { imageInput: body.capabilities.includes('vision') ? 'supported' : 'unsupported', source: 'provider_metadata' };
            cached.tools ??= {};
            cached.tools[model] = body.capabilities.includes('tools');
            cached.nonChatModels ??= [];
            if (!body.capabilities.includes('completion') && !cached.nonChatModels.includes(model))
              cached.nonChatModels.push(model);
          }
          source = 'service';
        }
        if (!capacity && catalogProviderId) {
          const info = (await catalogModels(catalogProviderId)).find(m => m.id === model);
          capacity = info?.contextWindow;
          const input = modelImageProfile(info, 'catalog');
          if (input && !cached.inputs?.[model]) { cached.inputs ??= {}; cached.inputs[model] = input; }
          if (!cached.outputs?.[model] && modelOutput(info) !== undefined) {
            cached.outputs ??= {}; cached.outputs[model] = modelOutput(info);
          }
          source = 'catalog';
        }
        cached.thinking ??= {};
        if (!Object.keys(cached.thinking[model] ?? {}).length && catalogProviderId)
          cached.thinking[model] = catalogThinkingProfile(catalogProviderId, model);
        if (capacity && !cached.contexts?.[model]) {
          cached.contexts ??= {}; cached.sources ??= {};
          cached.contexts[model] = capacity; cached.sources[model] = source;
        }
      } catch { /* Advisory metadata must not disable a working model route. */ }
    })());
    await cached.details.get(model);
  }
  // A model-list refresh replaces this cache while /api/show can still be in
  // flight. Its completion belongs to the retired entry. Resolve against the
  // current entry once, rather than publishing missing capabilities as a result.
  if (retryAfterRefresh && cached && cachedModels(provider) !== cached)
    return resolveContext(provider, model, authPending, false);
  return cachedModels(provider)?.contexts?.[model];
}

export async function resolveImageCapability(provider, model) {
  await resolveContext(provider, model);
  return cachedModels(provider)?.inputs?.[model] ?? { imageInput: 'unknown', source: 'unknown' };
}

async function validateSelection(provider, stored, legacyThinking) {
  const auth = await credentials(provider, stored);
  const resolved = { ...provider, apiKey: auth.key, headers: auth.customHeaders };
  const available = await discover(resolved, stored, { authPending: Promise.resolve(auth) });
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
  auth.requestHeaders.set("Content-Type", "application/json");
  const responses = completion.pathname.endsWith("/responses");
  // Resolve the same capabilities and preference as chat. Listing a model says
  // nothing about accepting function tools together with its thinking setting.
  const native = await driverProvider(resolved, provider.models[0]);
  const { applyModelThinking, modelThinkingPreference } = await import('./model-settings.mjs');
  const selected = applyModelThinking(native, modelThinkingPreference(thinkingProfile(resolved, provider.models[0]),
    provider.thinkingEfforts?.[provider.models[0]], legacyThinking));
  const effort = selected.provider.reasoningEfforts?.[selected.thinkingEffort];
  const reasoning = responses
    ? typeof effort === 'string' ? { reasoning: { effort } } : {}
    : selected.provider.compat?.thinkingFormat === 'chat-template'
      ? { chat_template_kwargs: { enable_thinking: selected.thinkingEffort != null && selected.thinkingEffort !== 'off' } }
      : typeof effort === 'string' ? { reasoning_effort: effort } : {};
  const budget = selected.thinkingEffort && selected.thinkingEffort !== 'off' && effort !== 'none'
    ? 4096 : PROBE_OUTPUT_TOKENS;
  const tool = { name: 'connection_check', description: 'Connection check only; no action is performed.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } };
  const payload = responses
    ? {
        model: provider.models[0],
        input: "Reply OK.",
        max_output_tokens: budget,
        tools: [{ type: 'function', ...tool }],
        ...reasoning,
        stream: false,
      }
    : {
        model: provider.models[0],
        messages: [{ role: "user", content: "Reply OK." }],
        ...(completion.origin === 'https://api.openai.com'
          ? { max_completion_tokens: budget }
          : { max_tokens: budget }),
        tools: [{ type: 'function', function: tool }],
        ...reasoning,
        stream: false,
      };
  const body = await requestJson(completion, {
    headers: auth.requestHeaders,
    method: "POST",
    payload,
  });
  const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
  const truncated = responses
    ? body.status === "incomplete" && body.incomplete_details?.reason === "max_output_tokens"
    : choice?.finish_reason === "length";
  if (truncated)
    throw providerError(
      "model_unavailable",
      "The service responded, but the test reached its output limit. Model availability could not be verified.",
    );
  const hasText = value => typeof value === "string" && value.trim().length > 0;
  const completed = responses
    ? (!body.status || body.status === "completed") &&
      (hasText(body.output_text) || (Array.isArray(body.output) && body.output.some(item =>
        item?.type === "message" && item.role === "assistant" && Array.isArray(item.content) &&
        item.content.some(part => part?.type === "output_text" && hasText(part.text)))))
    : (!choice?.finish_reason || choice.finish_reason === "stop") && hasText(choice?.message?.content);
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
    ...(current?.thinkingEfforts ? { thinkingEfforts: current.thinkingEfforts } : {}),
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
    store.read().preferences?.gooseThinkingEffort,
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
  const models = provider.models.filter(id => !cachedModels(provider)?.nonChatModels?.includes(id));
  return {
    providerId: provider.id,
    providerName: provider.displayName,
    description: "Model connection used by CodeBuddy",
    defaultModel: models[0] ?? "",
    configured: providerStatus(provider).isConfigured,
    providerType: "Custom",
    category: "model",
    configKeys: [],
    setupSteps: [],
    supportsRefresh: true,
    refreshing: false,
    models: orderedModels(provider, models, cachedModels(provider)?.created).map((id) => ({
      id,
      name: id,
      contextLimit: contextProfile(provider, id).contextWindow,
    })),
    stale: false,
  };
}

async function templateThinkingProfile(provider, model, headers, backend) {
  // The generic OpenAPI enum is not a model capability. Render the actual
  // template without inference: custom/quantized names need no name heuristics.
  const completionPath = endpoints(provider).completion.pathname;
  const url = new URL(backend === 'sglang'
    ? completionPath.replace(/chat\/completions$/, 'tokenize')
    : `${completionPath}/render`, provider.apiUrl);
  headers = new Headers(headers);
  headers.set('Content-Type', 'application/json');
  const levels = [undefined, 'medium', 'low', 'high', 'xhigh', 'minimal', 'max', 'none'];
  const rendered = await Promise.all(levels.map(async level => {
    try {
      const body = await requestJson(url, { method: 'POST', headers,
        payload: { model, messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: 1,
          ...(level === undefined ? {} : { reasoning_effort: level }) }, timeoutMs: 2000 });
      const tokens = backend === 'sglang' ? body.tokens : body.token_ids;
      if (!Array.isArray(tokens) || !tokens.length || !tokens.every(token => Number.isSafeInteger(token) && token >= 0)) return null;
      return JSON.stringify(tokens);
    } catch { return null; }
  }));
  if (!rendered[0]) return {};
  // Accepted but ignored fields must not become fake intensity settings. Only
  // expose distinct rendered modes, and preserve the service's existing default.
  const modes = new Map();
  for (let i = 1; i < levels.length; i++) {
    if (rendered[i] && !modes.has(rendered[i])) modes.set(rendered[i], levels[i]);
  }
  if (modes.size < 2 || !modes.has(rendered[0])) return {};
  const reasoningEfforts = Object.fromEntries([...modes.values()].map(level => [level === 'none' ? 'off' : level, level]));
  const defaultLevel = modes.get(rendered[0]);
  return { reasoningEfforts, thinkingDefault: defaultLevel === 'none' ? 'off' : defaultLevel,
    thinkingToggle: Object.keys(reasoningEfforts).every(level => ['off', 'medium'].includes(level)),
    compat: { thinkingFormat: 'openai', supportsReasoningEffort: true, supportsDeveloperRole: false } };
}

function modelThinkingProfile(model) {
  // Gemma 4 uses its published boolean chat-template switch, not reasoning_effort.
  if (!/^gemma-?4(?:[-:]|$)/i.test(model?.split('/').at(-1) ?? '')) return {};
  return {
    compat: { thinkingFormat: 'chat-template', chatTemplateKwargs: { enable_thinking: { $var: 'thinking.enabled' } }, supportsDeveloperRole: false },
    reasoningEfforts: { off: null, minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'high' },
    thinkingToggle: true,
  };
}

function ollamaThinkingProfile(body) {
  const values = body.thinking?.values;
  let efforts;
  if (Array.isArray(values) && values.length && values.every(value => typeof value === 'boolean')) {
    if (!values.includes(true)) return { reasoningEfforts: false };
    efforts = { ...(values.includes(false) ? { off: 'none' } : {}), medium: 'medium' };
  } else if (Array.isArray(values) && values.length && values.every(value => typeof value === 'string' || typeof value === 'boolean')) {
    // Cloud models can combine a boolean off switch with named effort levels.
    efforts = Object.fromEntries(values.flatMap(value => {
      if (value === false) return [['off', 'none']];
      if (value === true) return [['medium', 'medium']];
      return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)
        ? [[value === 'none' ? 'off' : value, value]] : [];
    }));
  } else if (Array.isArray(body.capabilities) && body.capabilities.includes('thinking')) {
    // Capability alone establishes an enabled control, not unsupported extra levels.
    efforts = { medium: 'medium' };
  }
  if (!efforts || !Object.keys(efforts).some(level => level !== 'off')) return {};
  return {
    reasoningEfforts: efforts,
    thinkingDefault: typeof body.thinking?.default === 'string' && body.thinking.default !== 'none' &&
      Object.hasOwn(efforts, body.thinking.default) ? body.thinking.default : undefined,
    thinkingToggle: Array.isArray(values) && values.every(value => typeof value === 'boolean') || Object.keys(efforts).every(level => ['off', 'medium'].includes(level)),
    compat: { thinkingFormat: 'openai', supportsReasoningEffort: true, supportsDeveloperRole: false },
  };
}

export function thinkingProfile(provider, model) {
  const discovered = cachedModels(provider)?.thinking?.[model];
  if (discovered && Object.hasOwn(discovered, 'reasoningEfforts')) return discovered;
  const catalogProviderId = providerCatalog(provider);
  if (catalogProviderId) {
    const catalog = catalogThinkingProfile(catalogProviderId, model);
    if (Object.hasOwn(catalog, 'reasoningEfforts')) return catalog;
  }
  // Only non-Ollama Gemma deployments use the existing chat-template adapter.
  const fallback = modelThinkingProfile(model);
  if (Object.keys(fallback).length && (provider.engine === 'ollama_compatible' || new URL(provider.apiUrl).hostname === 'ollama.com'))
    return { reasoningEfforts: { off: 'none', medium: 'medium' }, thinkingToggle: true,
      compat: { thinkingFormat: 'openai', supportsReasoningEffort: true, supportsDeveloperRole: false } };
  return fallback;
}

export async function resolvedModelInfo(provider, model) {
  if (!provider.models.includes(model)) throw invalid('Unknown model for this provider');
  if (providerStatus(provider).isConfigured) await resolveContext(provider, model);
  const profile = contextProfile(provider, model);
  return { provider: provider.id, model, contextLimit: profile.contextWindow,
    contextSource: profile.contextSource, reasoning: Boolean(thinkingProfile(provider, model).reasoningEfforts), currency: 'USD' };
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

export async function driverProvider(provider, model, { legacyThinking = false } = {}) {
  const authPending = credentials(provider, provider);
  const [auth] = await Promise.all([authPending, resolveContext(provider, model, authPending)]);
  if (cachedModels(provider)?.nonChatModels?.includes(model))
    throw providerError('model_unavailable', 'The selected model does not support chat completions.');
  if (cachedModels(provider)?.tools?.[model] === false)
    throw providerError('tools_unsupported', 'This Ollama model reports no tool-calling support. Select an installed model with the tools capability for CodeBuddy tasks.');
  const { key: apiKey, customHeaders: headers } = auth;
  const outputTokens = cachedModels(provider)?.outputs?.[model];
  const { thinkingToggle: _toggle, thinkingDefault: _default, compat, ...nativeThinking } = legacyThinking ? modelThinkingProfile(model) : thinkingProfile(provider, model);
  const protocol = endpoints(provider).completion.pathname.endsWith("/responses")
    ? "openai-responses" : "openai-completions";
  return {
    id: provider.id,
    baseUrl: modelBase(provider),
    apiKey,
    headers,
    // The official Harness/pi-ai adapter owns serialization and streaming.
    ...nativeThinking,
    // Thinking-profile compatibility fields describe Chat Completions only.
    // Responses has its own native reasoning serialization and rejects them.
    ...(protocol === 'openai-completions' && compat ? { compat } : {}),
    ...contextProfile(provider, model),
    ...(outputTokens === undefined ? {} : { outputTokenCapacity: outputTokens }),
    protocol,
  };
}
