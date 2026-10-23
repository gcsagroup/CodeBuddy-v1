export interface UninstallPlan {
  version: number; app: string; root: string; home: string;
  cleanData: boolean; deleteProjects: boolean; preserved: string[]; bytes: number;
  targets: Array<{ path: string; kind: string; bytes: number; identity: unknown }>;
  rootIdentity: unknown; appIdentity: unknown;
}
export function createPlan(options: {
  app: string; home: string; dataRoot: string; workspace?: string;
  cleanData?: boolean; deleteProjects?: boolean;
}): Promise<UninstallPlan>;
export function executePlan(plan: UninstallPlan, options?: object): Promise<object>;
export function waitForExit(pids: number[], timeout?: number): Promise<void>;
