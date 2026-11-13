const values = new Map<string, unknown>();
export async function getAcpControlClient() {
  throw new Error('Unexpected control request in compaction settings fixture');
}
export async function getAcpClient() {
  return {
    goose: {
      async configRead_unstable({ key }: { key: string }) {
        return { value: values.get(key) ?? null };
      },
      async configUpsert_unstable({ key, value }: { key: string; value: unknown }) {
        values.set(key, value);
        return {};
      },
      async providersList_unstable() {
        return {
          entries: [
            {
              providerId: 'fixture',
              providerName: 'CodeBuddy LAN',
              description: 'Synthetic settings fixture',
              defaultModel: 'qwen3.8-flash-next-uncensored',
              configured: true,
              providerType: 'Custom',
              category: 'model',
              configKeys: [],
              setupSteps: [],
              models: [
                { id: 'qwen3.8-flash-next-uncensored', contextLimit: 196608 },
                { id: 'gemma-4-26B-A4B-it-uncensored-FP8-W8A16', contextLimit: 65536 },
              ],
            },
          ],
        };
      },
    },
  };
}
