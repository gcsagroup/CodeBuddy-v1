import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';

export interface DistributionModel {
  providerId: string;
  baseUrl: string;
  modelId: string;
}

/** Seed fresh desktop profiles; explicit apply also updates an existing user's defaults. */
export function configureDistributionModel(
  configDir: string,
  model: DistributionModel,
  applyToExisting = false
): boolean {
  if (!/^custom_[a-z0-9_]+$/.test(model.providerId)) throw new Error('Invalid provider id');
  const url = new URL(model.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Invalid model endpoint');
  }
  const configPath = path.join(configDir, 'config.yaml');
  const original = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const document = yaml.parseDocument(original || '{}');
  if (document.errors.length || !yaml.isMap(document.contents)) {
    throw new Error('Invalid existing model configuration');
  }
  const current = document.toJS() as Record<string, unknown>;
  if (
    !applyToExisting &&
    (current.active_provider ||
      current.GOOSE_PROVIDER ||
      Object.keys((current.providers ?? {}) as object).length)
  ) {
    return false;
  }
  const providers = (current.providers ?? {}) as Record<string, unknown>;
  document.set('providers', {
    ...providers,
    [model.providerId]: { enabled: true, configured: true, model: model.modelId },
  });
  document.set('active_provider', model.providerId);
  // Older profiles may still have these explicit overrides.
  if (document.has('GOOSE_PROVIDER')) document.set('GOOSE_PROVIDER', model.providerId);
  if (document.has('GOOSE_MODEL')) document.set('GOOSE_MODEL', model.modelId);
  for (const role of ['PLANNER', 'CODER', 'TESTER', 'REVIEWER']) {
    document.set(`GOOSE_${role}_PROVIDER`, model.providerId);
    document.set(`GOOSE_${role}_MODEL`, model.modelId);
  }
  const routing = (current.GOOSE_CODEPRO_MODEL_ROUTING ?? {}) as Record<string, unknown>;
  document.set('GOOSE_CODEPRO_ADVANCED_MODEL_ROUTING', false);
  document.set('GOOSE_CODEPRO_MODEL_ROUTING', {
    ...routing,
    version: 2,
    advancedRoutingEnabled: false,
    routes: [],
    visionRoute: {
      enabled: true,
      mode: 'auto',
      providerId: model.providerId,
      modelId: model.modelId,
    },
    maxParallelCoders: routing.maxParallelCoders ?? 1,
  });
  document.set(
    'CODEAGENTPRO_PREFERENCES_REVISION',
    Number(current.CODEAGENTPRO_PREFERENCES_REVISION ?? 0) + 1
  );
  const providerDir = path.join(configDir, 'custom_providers');
  fs.mkdirSync(providerDir, { recursive: true });
  const providerPath = path.join(providerDir, `${model.providerId}.json`);
  const provider = {
    name: model.providerId,
    engine: 'openai',
    display_name: 'CodeBuddy LAN',
    description: 'Configured local network model service',
    base_url: model.baseUrl,
    models: [{ name: model.modelId, context_limit: 128000, reasoning: false }],
    supports_streaming: true,
    preserves_thinking: true,
    requires_auth: false,
  };
  // Preserve rollback files privately and detect a concurrent settings change.
  if (fs.existsSync(configPath) && fs.readFileSync(configPath, 'utf8') !== original) {
    throw new Error('Model configuration changed during update; retry');
  }
  if (original)
    fs.writeFileSync(`${configPath}.before-lan-${Date.now()}`, original, {
      mode: 0o600,
      flag: 'wx',
    });
  if (fs.existsSync(providerPath)) {
    fs.writeFileSync(`${providerPath}.before-lan-${Date.now()}`, fs.readFileSync(providerPath), {
      mode: 0o600,
      flag: 'wx',
    });
  }
  atomicWrite(providerPath, `${JSON.stringify(provider, null, 2)}\n`);
  atomicWrite(configPath, document.toString());
  return true;
}

function atomicWrite(filename: string, text: string): void {
  const temporary = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, filename);
}
