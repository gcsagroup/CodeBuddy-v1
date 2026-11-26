import { z } from 'zod';
import { getAcpControlClient } from './acpConnection';

const itemSchema = z.object({
  id: z.string(), content: z.string(), timestamp: z.number(), desktopGeneration: z.string(),
  images: z.array(z.object({ data: z.string(), mimeType: z.string() })),
  state: z.enum(['pending', 'dispatching', 'uncertain']),
});
const snapshotSchema = z.object({
  version: z.literal(1), revision: z.number(), paused: z.boolean(), activeRunId: z.string().nullable(),
  items: z.array(itemSchema),
  selection: z.object({ id: z.string(), ids: z.array(z.string()), expectedRunId: z.string().nullable() }).nullable(),
  commandApplied: z.boolean().optional(),
});
export type InputQueueSnapshot = z.infer<typeof snapshotSchema>;
export async function inputQueueRequest(sessionId: string, command: Record<string, unknown>) {
  const client = await getAcpControlClient();
  return snapshotSchema.parse(await client.extMethod('_codebuddy/session/input-queue', { sessionId, ...command }));
}
