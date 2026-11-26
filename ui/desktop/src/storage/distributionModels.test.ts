import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { configureDistributionModel } from './distributionModels';
import defaultModel from '../../../../runtime/default-model.json';

const directories: string[] = [];
const directory = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepro-model-defaults-'));
  directories.push(dir);
  return dir;
};
afterEach(() =>
  directories.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }))
);
const read = (dir: string) => yaml.parse(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8'));

describe('distribution model defaults', () => {
  it('initializes main, all roles and vision with the verified LAN service', () => {
    const dir = directory();
    expect(configureDistributionModel(dir, defaultModel)).toBe(true);
    const c = read(dir);
    expect(c.active_provider).toBe('custom_codebuddy_lan');
    for (const role of ['PLANNER', 'CODER', 'TESTER', 'REVIEWER']) {
      expect(c[`GOOSE_${role}_PROVIDER`]).toBe(c.active_provider);
      expect(c[`GOOSE_${role}_MODEL`]).toBe('gemma-4-26B-A4B-it-uncensored-FP8-W8A16');
    }
    expect(c.GOOSE_CODEPRO_MODEL_ROUTING.visionRoute).toEqual({
      enabled: true,
      mode: 'auto',
      providerId: c.active_provider,
      modelId: 'gemma-4-26B-A4B-it-uncensored-FP8-W8A16',
    });
    const provider = JSON.parse(
      fs.readFileSync(path.join(dir, 'custom_providers/custom_codebuddy_lan.json'), 'utf8')
    );
    expect(provider.base_url).toBe('http://192.168.50.231:8001');
    expect(provider.requires_auth).toBe(false);
    expect(provider.preserves_thinking).toBe(true);
    expect(configureDistributionModel(dir, defaultModel)).toBe(false);
  });
  it('keeps a subsequent manual model selection and configuration byte-for-byte', () => {
    const dir = directory();
    const original = '# user selected provider\nactive_provider: custom_manual\nproviders: {}\n';
    fs.writeFileSync(path.join(dir, 'config.yaml'), original);
    expect(configureDistributionModel(dir, defaultModel)).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')).toBe(original);
  });
  it('accepts an empty provider map and preserves unrelated settings', () => {
    const dir = directory();
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'providers: {}\nGOOSE_MODE: approve\n');
    configureDistributionModel(dir, defaultModel);
    expect(read(dir).GOOSE_MODE).toBe('approve');
  });
  it('explicitly updates existing defaults, keeps other providers and backs up original settings', () => {
    const dir = directory();
    const original = yaml.stringify({
      active_provider: 'old',
      providers: { old: { model: 'previous' } },
      GOOSE_PROVIDER: 'old',
      GOOSE_MODEL: 'previous',
      extensions: { tavily: { enabled: true } },
      GOOSE_CODEPRO_MODEL_ROUTING: {
        maxParallelCoders: 3,
        routes: [{ role: 'coder', providerId: 'old' }],
      },
      CODEAGENTPRO_PREFERENCES_REVISION: 17,
    });
    fs.writeFileSync(path.join(dir, 'config.yaml'), original);
    configureDistributionModel(dir, defaultModel, true);
    const c = read(dir);
    expect(c.providers.old.model).toBe('previous');
    expect(c.extensions.tavily.enabled).toBe(true);
    expect(c.GOOSE_PROVIDER).toBe('custom_codebuddy_lan');
    expect(c.GOOSE_MODEL).toBe('gemma-4-26B-A4B-it-uncensored-FP8-W8A16');
    expect(c.GOOSE_CODEPRO_MODEL_ROUTING.routes).toEqual([]);
    expect(c.GOOSE_CODEPRO_MODEL_ROUTING.maxParallelCoders).toBe(3);
    expect(c.CODEAGENTPRO_PREFERENCES_REVISION).toBe(18);
    const backup = fs.readdirSync(dir).find((name) => name.startsWith('config.yaml.before-lan-'))!;
    expect(fs.readFileSync(path.join(dir, backup), 'utf8')).toBe(original);
  });
  it('rejects malformed configuration without overwriting it', () => {
    const dir = directory();
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'providers: [');
    expect(() => configureDistributionModel(dir, defaultModel, true)).toThrow();
    expect(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')).toBe('providers: [');
  });
});
