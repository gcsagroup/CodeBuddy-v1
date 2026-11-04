import { getAcpControlClient } from '../../acp/acpConnection';

export interface AgentProfile {
  id?: string; revision?: number; name: string; avatar: string;
  prompt: string; skills: string[]; tools: string[]; mcpServers: string[]; capabilities?: 'inherit' | 'selected';
}
export interface AgentSelection { revision: number; profile: AgentProfile | null; legacy: boolean }
export interface AgentPreset { key: string; description: string; tags: string[]; profile: AgentProfile }

export async function agentRequest<T>(action: string, data: Record<string, unknown> = {}): Promise<T> {
  const client = await getAcpControlClient();
  return await client.extMethod(`_codebuddy/agents/${action}`, data) as unknown as T;
}
