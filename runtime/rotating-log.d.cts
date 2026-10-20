import type { Writable } from 'node:stream';
export function createRotatingLog(file: string, maxBytes?: number): Writable;
