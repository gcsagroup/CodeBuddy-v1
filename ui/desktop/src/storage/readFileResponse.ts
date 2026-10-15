import fs from 'node:fs/promises';

// Use the same filesystem error contract on every desktop platform.
export async function readFileResponse(filePath: string) {
  try {
    return { file: await fs.readFile(filePath, 'utf8'), filePath, error: null, found: true };
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    return {
      file: '',
      filePath,
      found: false,
      error: missing ? null : error instanceof Error ? error.message : String(error),
    };
  }
}
