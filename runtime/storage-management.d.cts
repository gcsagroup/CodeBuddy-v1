export interface MigrationRecord {
  version: number;
  id: string;
  source: string;
  target: string;
  projectsPath: string;
  status: "pending" | "copying" | "completed" | "failed";
  error?: string;
  workerPid: number | null;
  parentPid: number;
  copiedFiles?: number;
  copiedBytes?: number;
}
export function locationFile(
  env?: NodeJS.ProcessEnv,
  home?: string,
  platform?: string,
): string;
export function managedRoot(value: string): string;
export function readDataRoot(file: string, fallback: string): string;
export function assertNoMigration(file: string): void;
export function readMigration(file: string): MigrationRecord | null;
export function jobFileFor(file: string): string;
