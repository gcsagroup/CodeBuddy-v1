import { randomUUID } from 'node:crypto';
import { revealSecret } from './secrets.mjs';

const nativeShellTools = new Set(['pwsh', 'bash', 'shell']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = code => Object.assign(new Error(code), { safetyCode: code });
const boolean = (value, fallback = false) => { if (value == null) return fallback; if (typeof value !== 'boolean') throw failure('invalid_configuration'); return value; };
const override = value => value === true || value === 'true' ? true : value === false || value === 'false' ? false : undefined;
const configValue = (config, key) => config[key]?.value;

function endpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw failure('invalid_classifier_endpoint'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw failure('invalid_classifier_endpoint');
  return url.href;
}

// Original Goose classifier transport and score policy are retained. A
// classifier may escalate approval but cannot grant permission or execute.
export class SafetyPolicy {
  constructor(store, { modelMapping, overrides = {}, fetch: fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
    this.store = store;
    this.modelMapping = modelMapping;
    this.overrides = overrides;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.cachedKey = null;
    this.cachedConfiguration = null;
  }

  async configuration() {
    // Shell approval needs configuration, never a clone of historical messages
    // and image/tool payloads from every unrelated conversation.
    const config = this.store.read(['config']).config ?? {};
    const enabled = override(this.overrides.promptEnabled) ?? boolean(configValue(config, 'SECURITY_PROMPT_ENABLED'));
    if (!enabled) return { enabled: false };
    const threshold = configValue(config, 'SECURITY_PROMPT_THRESHOLD') ?? 0.8;
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw failure('invalid_threshold');
    const key = JSON.stringify([config, this.modelMapping, this.overrides]);
    if (key !== this.cachedKey) {
      this.cachedKey = key;
      this.cachedConfiguration = (async () => ({
        enabled: true, threshold,
        command: await this.classifier(config, 'COMMAND', override(this.overrides.commandEnabled)),
        prompt: await this.classifier(config, 'PROMPT'),
      }))();
    }
    return this.cachedConfiguration;
  }

  async classifier(config, kind, forced) {
    const prefix = `SECURITY_${kind}_CLASSIFIER_`;
    const enabled = forced ?? boolean(configValue(config, prefix + 'ENABLED'));
    if (!enabled) return { enabled: false };
    try {
      const name = configValue(config, prefix + 'MODEL');
      const direct = configValue(config, prefix + 'ENDPOINT');
      if (name != null && typeof name !== 'string') throw failure('invalid_configuration');
      if (direct != null && typeof direct !== 'string') throw failure('invalid_classifier_endpoint');
      if (name?.trim() || (!direct?.trim() && kind === 'COMMAND')) {
        let mapping = this.modelMapping;
        if (typeof mapping === 'string') { try { mapping = JSON.parse(mapping); } catch { throw failure('invalid_model_mapping'); } }
        if (!record(mapping)) throw failure('classifier_not_configured');
        const selected = name?.trim() ? mapping[name.trim()] : Object.values(mapping).find(row => row?.model_type === 'command');
        if (!record(selected)) throw failure('classifier_not_configured');
        const { endpoint: url, model_type: _type, ...parameters } = selected;
        return { enabled: true, url: endpoint(url), parameters };
      }
      if (!direct?.trim()) throw failure('classifier_not_configured');
      const secret = config[prefix + 'TOKEN'];
      if (secret?.value) throw failure('classifier_token_requires_protected_storage');
      let token;
      try { token = (await revealSecret(secret?.secret)).trim(); } catch { throw failure('classifier_credentials_unavailable'); }
      return { enabled: true, url: endpoint(direct.trim()), token };
    } catch (error) { return { enabled: true, error: error.safetyCode ?? 'invalid_configuration' }; }
  }

  async inspect({ tool, userMessages = [], signal } = {}) {
    signal?.throwIfAborted();
    if (!nativeShellTools.has(tool?.name)) return { status: 'not_applicable', requiresApproval: false, confidence: null };
    let configuration;
    try { configuration = await this.configuration(); } catch (error) { return verdict('unavailable', null, null, [error.safetyCode ?? 'invalid_configuration']); }
    signal?.throwIfAborted();
    if (!configuration.enabled) return { status: 'disabled', requiresApproval: false, confidence: null };
    const { command, prompt, threshold } = configuration;
    const reasons = [];
    const commandText = tool.arguments?.command;
    if (typeof commandText !== 'string') return verdict('unavailable', null, threshold, ['missing_shell_command']);
    const chunks = commandWindows(commandText);
    const recent = userMessages.filter(value => typeof value === 'string' && value.length > 0).slice(-10);
    const [commandScan, promptScan] = await Promise.all([
      this.scan(command, chunks.windows, signal),
      this.scan(prompt, recent, signal),
    ]);
    signal?.throwIfAborted();
    if (!command.enabled) reasons.push('command_classifier_disabled');
    if (!chunks.complete) reasons.push('command_scan_incomplete');
    reasons.push(...commandScan.errors, ...promptScan.errors);
    const confidence = commandScan.score == null ? null : combinedScore(commandScan.score, promptScan.score);
    const incomplete = !command.enabled || !chunks.complete || reasons.length > 0;
    const status = confidence != null && confidence > threshold ? 'flagged' : incomplete ? 'unavailable' : 'clear';
    const result = verdict(status, confidence, threshold, [...new Set(reasons)]);
    result.classifierScores = { command: commandScan.score, prompt: promptScan.score };
    result.coverage = { command: { enabled: command.enabled, succeeded: commandScan.succeeded, failed: commandScan.failed, complete: chunks.complete }, prompt: { enabled: prompt.enabled, succeeded: promptScan.succeeded, failed: promptScan.failed, messages: recent.length } };
    return result;
  }

  async scan(classifier, texts, signal) {
    if (!classifier.enabled || texts.length === 0) return { score: null, succeeded: 0, failed: 0, errors: [] };
    if (classifier.error) return { score: null, succeeded: 0, failed: texts.length, errors: [classifier.error] };
    const results = new Array(texts.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, texts.length) }, async () => {
      while (next < texts.length) {
        signal?.throwIfAborted();
        const index = next++;
        try { results[index] = { score: await this.classify(classifier, texts[index], signal) }; }
        catch (error) { signal?.throwIfAborted(); results[index] = { error: error.safetyCode ?? 'classifier_request_failed' }; }
      }
    }));
    const scores = results.filter(row => row.score !== undefined).map(row => row.score);
    return { score: scores.length ? Math.max(...scores) : null, succeeded: scores.length, failed: results.length - scores.length, errors: results.flatMap(row => row.error ? [row.error] : []) };
  }

  async classify(classifier, input, signal) {
    if (Buffer.byteLength(input) > 64 * 1024) throw failure('classifier_input_too_large');
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await this.fetch(classifier.url, {
        method: 'POST', redirect: 'error', signal: requestSignal,
        headers: { 'content-type': 'application/json', ...(classifier.token ? { authorization: `Bearer ${classifier.token}` } : {}) },
        body: JSON.stringify({ inputs: input, ...(classifier.parameters ? { parameters: classifier.parameters } : {}) }),
      });
      if (!response.ok) { await response.body?.cancel(); throw failure('classifier_http_error'); }
      const buffers = []; let bytes = 0;
      for await (const buffer of response.body) {
        bytes += buffer.length;
        if (bytes > 64 * 1024) throw failure('classifier_response_too_large');
        buffers.push(buffer);
      }
      let value;
      try { value = JSON.parse(Buffer.concat(buffers).toString('utf8')); } catch { throw failure('invalid_classifier_response'); }
      return injectionScore(value);
    } catch (error) {
      signal?.throwIfAborted();
      if (timeout.aborted) throw failure('classifier_timeout');
      throw error.safetyCode ? error : failure('classifier_request_failed');
    }
  }
}

function verdict(status, confidence, threshold, reasonCodes) {
  const requiresApproval = status === 'flagged' || status === 'unavailable';
  return {
    status, requiresApproval, confidence, threshold, reasonCodes,
    ...(requiresApproval ? { findingId: `SEC-${randomUUID()}` } : {}),
    explanation: status === 'flagged'
      ? 'The configured security classifier exceeded the detection threshold. Confirm this tool call before execution.'
      : status === 'unavailable'
        ? 'Security detection is enabled, but classification was not completed. Confirm this tool call; this result is not a clean scan.'
        : 'The configured classifier score did not exceed the detection threshold. Existing tool permissions still apply.',
  };
}

function injectionScore(value) {
  const labels = Array.isArray(value) && value.length === 1 && Array.isArray(value[0]) ? value[0] : value;
  if (!Array.isArray(labels) || labels.length === 0 || labels.length > 32) throw failure('invalid_classifier_response');
  const classes = new Set();
  for (const label of labels) {
    if (!record(label) || !['INJECTION', 'LABEL_1', 'SAFE', 'LABEL_0'].includes(label.label) || !Number.isFinite(label.score)) throw failure('invalid_classifier_response');
    const category = label.label === 'INJECTION' || label.label === 'LABEL_1' ? 'injection' : 'safe';
    if (classes.has(category)) throw failure('invalid_classifier_response');
    classes.add(category);
  }
  const sum = labels.reduce((total, row) => total + row.score, 0);
  const probabilities = labels.every(row => row.score >= 0 && row.score <= 1) && Math.abs(sum - 1) < 0.1;
  const max = Math.max(...labels.map(row => row.score));
  const exps = labels.map(row => Math.exp(row.score - max));
  const divisor = exps.reduce((total, score) => total + score, 0);
  const normalized = labels.map((row, index) => ({ label: row.label, score: probabilities ? row.score : exps[index] / divisor }));
  const top = normalized.reduce((best, row) => row.score > best.score ? row : best);
  return top.label === 'INJECTION' || top.label === 'LABEL_1' ? top.score : 1 - top.score;
}

function combinedScore(command, prompt) {
  if (prompt == null || command < 0.3) return command;
  if (prompt < 0.3) return command * 0.9;
  if (command > 0.8 && prompt > 0.8) return Math.min(Math.max(command, prompt) * 1.05, 1);
  return command * 0.8 + prompt * 0.2;
}

// Match the existing 500-byte / 256-byte overlap windows, preserving UTF-8
// boundaries. An unscanned tail is observable rather than classified as safe.
function commandWindows(input) {
  const data = Buffer.from(input), windows = [];
  const boundary = index => { while (index > 0 && index < data.length && (data[index] & 0xc0) === 0x80) index--; return index; };
  let start = 0, end = 0;
  do {
    end = boundary(Math.min(start + 500, data.length));
    windows.push(data.subarray(start, end).toString('utf8'));
    if (end >= data.length) break;
    start = boundary(start + 244);
  } while (windows.length < 12);
  return { windows, complete: end === data.length };
}
