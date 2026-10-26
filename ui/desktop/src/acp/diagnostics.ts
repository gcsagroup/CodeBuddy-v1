import { getAcpClient } from './acpConnection';
import type { DiagnosticsLevel, DiagnosticsReport } from '../types/diagnostics';

export async function getDiagnosticsReport(
  sessionId: string,
  level: DiagnosticsLevel
): Promise<DiagnosticsReport> {
  const client = await getAcpClient();
  const response = await client.goose.diagnosticsGet_unstable({
    sessionId,
    level,
  });
  return response.report as DiagnosticsReport;
}

const githubConnections = new Map<string, Promise<{ success: boolean; code?: string }>>();

export function connectGitHubMcp(login: string): Promise<{ success: boolean; code?: string }> {
  const pending = githubConnections.get(login);
  if (pending) return pending;
  const operation = connectAccount(login).finally(() => githubConnections.delete(login));
  githubConnections.set(login, operation);
  return operation;
}

async function connectAccount(login: string): Promise<{ success: boolean; code?: string }> {
  const client = await getAcpClient();
  const result = (await client.extMethod('_goose/unstable/github/mcp/connect', { login })) as {
    success?: unknown;
    code?: unknown;
  };
  if (typeof result?.success !== 'boolean') throw new Error('Invalid GitHub connection result');
  return {
    success: result.success,
    code: typeof result.code === 'string' ? result.code : undefined,
  };
}
