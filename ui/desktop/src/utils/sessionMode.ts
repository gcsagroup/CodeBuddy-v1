import type { GooseMode } from '../types/session';

export function parseSessionMode(value: unknown): GooseMode | undefined {
  switch (value) {
    case 'read-only':
    case 'workspace-write':
    case 'danger-full-access':
      return value;
    default:
      return undefined;
  }
}
