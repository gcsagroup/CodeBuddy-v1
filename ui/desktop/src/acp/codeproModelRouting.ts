import { getAcpClient } from './acpConnection';

const READ_METHOD = '_goose/unstable/codepro/model-routing/read';
const SAVE_METHOD = '_goose/unstable/codepro/model-routing/save';

export type CodeProModelRoutingRole = 'main' | 'planner' | 'coder' | 'tester' | 'reviewer';

export interface CodeProModelRoute {
  role: CodeProModelRoutingRole;
  providerId: string;
  modelId: string;
}

export type CodeProVisionRoutingMode = 'auto' | 'always' | 'disabled';

export interface CodeProVisionRoute {
  enabled: boolean;
  mode: CodeProVisionRoutingMode;
  providerId?: string;
  modelId?: string;
}

export interface CodeProModelRoutingConfig {
  version: 2;
  advancedRoutingEnabled: boolean;
  routes: CodeProModelRoute[];
  visionRoute: CodeProVisionRoute;
  maxParallelCoders: number;
}

export const DISABLED_CODEPRO_MODEL_ROUTING: CodeProModelRoutingConfig = {
  version: 2,
  advancedRoutingEnabled: false,
  routes: [],
  visionRoute: { enabled: false, mode: 'disabled' },
  maxParallelCoders: 1,
};

export function disableCodeProAdvancedRouting(
  current: CodeProModelRoutingConfig | null
): CodeProModelRoutingConfig {
  return {
    ...(current ?? DISABLED_CODEPRO_MODEL_ROUTING),
    advancedRoutingEnabled: false,
    visionRoute: current?.visionRoute ?? DISABLED_CODEPRO_MODEL_ROUTING.visionRoute,
  };
}

export interface CodeProDefaultModelTransactionResult {
  revision: number;
  status: 'applied' | 'failed' | 'superseded';
}

let latestDefaultModelRevision = 0;
let defaultModelTransactionQueue: Promise<void> = Promise.resolve();

export async function readCodeProModelRouting(): Promise<CodeProModelRoutingConfig | null> {
  const client = await getAcpClient();
  const response = (await client.extMethod(READ_METHOD, {})) as {
    config?: CodeProModelRoutingConfig | null;
  };
  return response.config ?? null;
}

export async function saveCodeProModelRouting(config: CodeProModelRoutingConfig): Promise<void> {
  const client = await getAcpClient();
  await client.extMethod(SAVE_METHOD, { config });
}

export function applyCodeProDefaultModelTransaction(
  applyModelAndDefaults: () => Promise<boolean>
): Promise<CodeProDefaultModelTransactionResult> {
  const revision = ++latestDefaultModelRevision;
  const transaction = defaultModelTransactionQueue.then(async () => {
    if (revision !== latestDefaultModelRevision) {
      return { revision, status: 'superseded' as const };
    }

    const previousRouting = await readCodeProModelRouting();
    // An ordinary switch must not revalidate unchanged auxiliary preferences.
    // Only persist a routing change when advanced routing actually needs disabling.
    const routingChanged = previousRouting?.advancedRoutingEnabled === true;
    if (routingChanged) {
      await saveCodeProModelRouting({
        ...previousRouting,
        advancedRoutingEnabled: false,
      });
    }
    const applied = await applyModelAndDefaults();

    if (!applied) {
      if (revision === latestDefaultModelRevision && routingChanged && previousRouting) {
        await saveCodeProModelRouting(previousRouting);
      }
      return { revision, status: 'failed' as const };
    }

    return {
      revision,
      status:
        revision === latestDefaultModelRevision ? ('applied' as const) : ('superseded' as const),
    };
  });
  defaultModelTransactionQueue = transaction.then(
    () => undefined,
    () => undefined
  );
  return transaction;
}
