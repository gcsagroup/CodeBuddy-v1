import { getAcpClient } from './acpConnection';

const LIST_METHOD = '_goose/unstable/capability-usage/list';
const RECORD_METHOD = '_goose/unstable/capability-usage/record-success';

export type CapabilityUsageKind = 'skill' | 'external' | 'app' | 'common_task' | 'automatic_task';

export interface CapabilityUsageRecord {
  kind: CapabilityUsageKind;
  capabilityId: string;
  lastSuccessAt: string;
  successCount: number;
  recentResult: string;
  reference?: string;
}

export interface CapabilityUsageListResult {
  records: CapabilityUsageRecord[];
  warning?: string;
}

export interface CapabilityUsageEvent {
  eventId: string;
  kind: CapabilityUsageKind;
  capabilityId: string;
  recentResult: string;
  reference?: string;
}

export async function listCapabilityUsage(): Promise<CapabilityUsageListResult> {
  const client = await getAcpClient();
  const response = (await client.extMethod(
    LIST_METHOD,
    {}
  )) as unknown as CapabilityUsageListResult;
  return {
    records: response.records ?? [],
    warning: response.warning ?? undefined,
  };
}

export async function recordCapabilitySuccess(event: CapabilityUsageEvent): Promise<boolean> {
  const client = await getAcpClient();
  const response = (await client.extMethod(RECORD_METHOD, { ...event })) as { recorded: boolean };
  return response.recorded;
}

export async function recordCommonTaskSessionStarted(
  recipeId: string,
  sessionId: string,
  recordSuccess: (event: CapabilityUsageEvent) => Promise<boolean> = recordCapabilitySuccess
): Promise<void> {
  await recordSuccess({
    eventId: `common-task:${sessionId}`,
    kind: 'common_task',
    capabilityId: recipeId,
    recentResult: 'session started',
    reference: `common-task:${recipeId}`,
  }).catch((error) => console.warn('Failed to record common task usage:', error));
}
