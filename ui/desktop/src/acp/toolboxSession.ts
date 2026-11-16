import { requireNetworkAccess } from '../utils/networkAccess';
import { getAcpControlClient } from './acpConnection';

export interface ToolboxSessionState {
  cwd?: string;
  mode: 'follow' | 'custom' | 'restricted';
  pending: boolean;
  running: boolean;
  selected: string[];
  statuses: { serverName: string; status: string; error?: string }[];
}

export async function readToolboxSession(sessionId: string): Promise<ToolboxSessionState> {
  const client = await getAcpControlClient();
  return (await client.extMethod('_goose/unstable/session/extensions/state', {
    sessionId,
  })) as unknown as ToolboxSessionState;
}

export async function setToolboxSessionMode(
  sessionId: string,
  mode: 'follow' | 'custom'
): Promise<void> {
  const client = await getAcpControlClient();
  await client.extMethod('_goose/unstable/session/extensions/mode', { sessionId, mode });
}

export async function retryToolboxSession(sessionId: string): Promise<void> {
  await requireNetworkAccess();
  const client = await getAcpControlClient();
  await client.extMethod('_goose/unstable/session/extensions/retry', { sessionId });
}
