export const fixtureModel = 'deepseek-v4.1-flash:1017-extra-long-model-name';
export const fixtureProvider = 'composer-fixture';

export function useModelAndProvider() {
  return {
    currentModel: fixtureModel,
    currentProvider: fixtureProvider,
    getCurrentModelAndProvider: async () => ({ model: fixtureModel, provider: fixtureProvider }),
    changeModel: async () => true,
  };
}
