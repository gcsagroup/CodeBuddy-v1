import type { GooseMode } from '../types/session';

export function parseSessionMode(value: unknown): GooseMode | undefined {
  switch (value) {
    case 'auto':
    case 'approve':
    case 'smart_approve':
    case 'chat':
      return value;
    default:
      return undefined;
  }
}
