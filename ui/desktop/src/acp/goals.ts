import { z } from 'zod';
import { getAcpControlClient } from './acpConnection';

const goalSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().positive(),
  objective: z.string(),
  phase: z.enum(['active', 'paused', 'blocked', 'complete']),
  activation: z.enum(['armed', 'disarmed']),
  roundsStarted: z.number().int().nonnegative(),
  maxGoalRounds: z.number().int().positive(),
  blockedReason: z.object({ code: z.string(), message: z.string() }).optional(),
});
const responseSchema = z.object({ goal: goalSchema.nullable() });
export type LongTermGoal = z.infer<typeof goalSchema>;

export async function getSessionGoal(sessionId: string): Promise<LongTermGoal | null> {
  const client = await getAcpControlClient();
  return responseSchema.parse(
    await client.extMethod('_goose/unstable/session/goal/get', { sessionId })
  ).goal;
}

export async function pauseSessionGoal(
  sessionId: string,
  goal: LongTermGoal
): Promise<LongTermGoal | null> {
  const client = await getAcpControlClient();
  return responseSchema.parse(
    await client.extMethod('_goose/unstable/session/goal/pause', {
      sessionId,
      goalId: goal.id,
      revision: goal.revision,
    })
  ).goal;
}

export async function setSessionPlanMode(sessionId: string, active: boolean) {
  const client = await getAcpControlClient();
  return z
    .object({ plan: z.object({ active: z.boolean(), pending: z.boolean().optional() }) })
    .parse(await client.extMethod('_goose/unstable/session/plan/set', { sessionId, active })).plan;
}

export async function getSessionPlanMode(sessionId: string) {
  const client = await getAcpControlClient();
  return z
    .object({ plan: z.object({ active: z.boolean() }) })
    .parse(await client.extMethod('_goose/unstable/session/plan/get', { sessionId })).plan;
}

export async function changeSessionGoal(
  sessionId: string,
  goal: LongTermGoal,
  action: 'edit' | 'clear',
  objective?: string
) {
  const client = await getAcpControlClient();
  return responseSchema.parse(
    await client.extMethod(`_goose/unstable/session/goal/${action}`, {
      sessionId,
      goalId: goal.id,
      revision: goal.revision,
      ...(action === 'edit' ? { objective } : {}),
    })
  ).goal;
}
