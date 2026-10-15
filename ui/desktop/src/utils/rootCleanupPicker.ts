import type { OpenDialogOptions } from 'electron';
import path from 'node:path';

interface CleanupRootStats {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export function rootCleanupDialogOptions(
  rootPath: string,
  stats: CleanupRootStats
): OpenDialogOptions {
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) {
    throw new Error('Root cleanup picker requires an absolute root path');
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('Root cleanup picker requires a non-link directory root');
  }
  return {
    title: 'Select one exact cleanup target',
    defaultPath: rootPath,
    properties: ['openFile', 'openDirectory'],
  };
}
