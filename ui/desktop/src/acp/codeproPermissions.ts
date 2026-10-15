import { getAcpClient } from './acpConnection';

const GRANT_RESTRICTED_READONLY_METHOD =
  '_goose/unstable/codepro/workspace/grant-restricted-readonly';

export async function grantCodeProRestrictedReadonly(sessionId: string): Promise<void> {
  const client = await getAcpClient();
  await client.extMethod(GRANT_RESTRICTED_READONLY_METHOD, { sessionId });
}
