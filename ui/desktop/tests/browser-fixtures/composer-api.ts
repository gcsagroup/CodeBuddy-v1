import { fixtureModel, fixtureProvider } from './composer-model-context';

const profile = {
  id: 'layout-role',
  revision: 1,
  name: '后端开发与接口验收专家超长名称',
  avatar: '🐱',
  prompt: '隔离布局夹具',
  skills: [],
  tools: [],
  mcpServers: [],
  capabilities: 'inherit',
};
let selected: typeof profile | null = profile;
const selection = () => ({ revision: 1, profile: selected, legacy: false });
const modelInfo = { provider: fixtureProvider, model: fixtureModel, contextLimit: 1000000 };
const client = {
  goose: {
    slashCommandsList_unstable: async () => {
      if (!(window as unknown as { delayCommandInventory?: boolean }).delayCommandInventory) return { availableCommands: [] };
      return new Promise(resolve => Object.assign(window, { releaseCommandInventory: () => resolve({ availableCommands: Array.from({ length: 40 }, (_, i) => ({ name: `late-skill-${i}`, description: '异步加载的技能说明', _meta: { commandType: 'Skill' } })) }) }));
    },
    providersCanonicalModelInfo_unstable: async () => ({ modelInfo }),
    providersConfigRead_unstable: async () => ({
      fields: [
        {
          key: `thinkingEffort:${fixtureModel}`,
          value: JSON.stringify({
            options: ['low', 'medium', 'high'],
            value: 'high',
            toggle: false,
          }),
        },
      ],
    }),
    providersList_unstable: async () => {
      const bridge = window as unknown as { fixtureModelInventory?: () => Promise<unknown> };
      return bridge.fixtureModelInventory ? bridge.fixtureModelInventory() : { entries: [] };
    },
    providersInventoryRefresh_unstable: async (request: { providerIds: string[] }) => {
      const bridge = window as unknown as { fixtureRefreshModels: (request: { providerIds: string[] }) => Promise<unknown> };
      return bridge.fixtureRefreshModels(request);
    },
    preferencesRead_unstable: async () => ({ revision: 0, values: [] }),
    dictationConfig_unstable: async () => ({ providers: {} }),
    sessionExtensionsList_unstable: async () => ({ extensions: [] }),
  },
  extMethod: async (method: string, input: Record<string, unknown>) => {
    if (method === '_codebuddy/agents/list') return { profiles: [profile], presets: [] };
    if (method === '_codebuddy/agents/current')
      return { selection: selection(), effective: selected, pending: false };
    if (method === '_codebuddy/agents/select') {
      selected = input.id ? profile : null;
      return { selection: selection(), effective: selected, pending: false };
    }
    if (method.endsWith('/goal/get')) return { goal: null };
    if (method.endsWith('/plan/get')) return { plan: { active: false } };
    throw new Error(`Unexpected composer fixture request: ${method}`);
  },
};
export async function getAcpClient() {
  return client;
}
export async function getAcpControlClient() {
  return client;
}
export function isAcpRecovering() {
  return false;
}
export async function getAcpInitializeResponse() {
  return { capabilities: {} };
}
