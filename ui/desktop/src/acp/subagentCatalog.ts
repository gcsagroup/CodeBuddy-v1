import { getAcpControlClient } from './acpConnection';
import { isRecord } from './adapter/shared';

// Mirrors the fixed Harness catalog. A discovery mode is not a running state.
export type SubagentCatalogEntry = {
  id: string;
  createdAt: number;
} & (
  | { mode: 'continuable'; label: string }
  | { mode: 'one-shot' | 'external' | 'unknown'; label?: string }
);

export interface SubagentCatalogPage {
  sessionId: string;
  ancestorSessionIds: string[];
  children: SubagentCatalogEntry[];
}

function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function isCatalogEntry(value: unknown): value is SubagentCatalogEntry {
  return (
    isRecord(value) &&
    isSessionId(value.id) &&
    typeof value.createdAt === 'number' &&
    Number.isSafeInteger(value.createdAt) &&
    value.createdAt >= 0 &&
    (value.mode === 'one-shot' ||
      value.mode === 'continuable' ||
      value.mode === 'external' ||
      value.mode === 'unknown') &&
    (value.mode === 'continuable'
      ? typeof value.label === 'string'
      : value.label === undefined || typeof value.label === 'string')
  );
}

/** Read the parent's durable catalog through the control connection.
 * The path excludes the product root and ends at the directory being listed.
 * Reading neither activates an Agent nor supplies an execution status.
 */
export async function readSubagentCatalog(
  sessionId: string,
  ancestorSessionIds: readonly string[] = []
): Promise<SubagentCatalogPage> {
  if (
    !isSessionId(sessionId) ||
    !Array.isArray(ancestorSessionIds) ||
    ancestorSessionIds.length > 32 ||
    !ancestorSessionIds.every(isSessionId) ||
    ancestorSessionIds.includes(sessionId) ||
    new Set(ancestorSessionIds).size !== ancestorSessionIds.length
  )
    throw new Error('Invalid subagent catalog request');

  // The caller may navigate again while the transport is opening. Bind this
  // response to the original ordered path rather than a shared mutable array.
  const ancestors = [...ancestorSessionIds];
  const client = await getAcpControlClient();
  const value: unknown = await client.extMethod('_goose/unstable/subagent/catalog/list', {
    sessionId,
    ancestorSessionIds: ancestors,
  });
  if (
    !isRecord(value) ||
    value.sessionId !== sessionId ||
    !Array.isArray(value.ancestorSessionIds) ||
    value.ancestorSessionIds.length !== ancestors.length ||
    !value.ancestorSessionIds.every((id, index) => id === ancestors[index]) ||
    !Array.isArray(value.children) ||
    !value.children.every(isCatalogEntry)
  )
    throw new Error('Invalid subagent catalog response');

  return {
    sessionId,
    ancestorSessionIds: [...ancestors],
    children: value.children.map((child: SubagentCatalogEntry): SubagentCatalogEntry => {
      const identity = { id: child.id, createdAt: child.createdAt };
      if (child.mode === 'continuable')
        return { ...identity, mode: child.mode, label: child.label };
      return {
        ...identity,
        mode: child.mode,
        ...(child.label === undefined ? {} : { label: child.label }),
      };
    }),
  };
}
