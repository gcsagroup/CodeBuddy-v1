import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

export interface McpFilesystemOracle {
  firstNonEmptyLine: string;
  metadata: {
    fileName: string;
    length: number;
    lastWriteTimeUtc: string;
    sha256: string;
  };
}

export function readMcpFilesystemOracle(target: string): McpFilesystemOracle {
  const bytes = readFileSync(target);
  const firstNonEmptyLine = bytes
    .toString('utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstNonEmptyLine) throw new Error('MCP acceptance target contains no non-empty text');
  const stat = statSync(target);
  return {
    firstNonEmptyLine,
    metadata: {
      fileName: basename(target),
      length: stat.size,
      lastWriteTimeUtc: stat.mtime.toISOString(),
      sha256: createHash('sha256').update(bytes).digest('hex').toUpperCase(),
    },
  };
}

export function writeMcpFilesystemEvidence(
  metadata: McpFilesystemOracle['metadata'],
  checks: Record<string, boolean | number | string>
): string {
  const evidenceDir = resolve(
    process.cwd(),
    '..',
    '..',
    '.cargo',
    'evidence',
    'toolbox-mcp-acceptance'
  );
  mkdirSync(evidenceDir, { recursive: true });
  const path = join(evidenceDir, 'playwright-summary.json');
  writeFileSync(path, JSON.stringify({ metadata, checks }, null, 2), 'utf8');
  return path;
}
