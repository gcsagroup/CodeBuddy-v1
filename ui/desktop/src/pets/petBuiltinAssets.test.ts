import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validatePetManifest } from './petPolicy';

describe('distributed animal assets', () => {
  it('ships three distinct PNG packages with the renderer dimensions', async () => {
    const hashes = new Set<string>();
    for (const id of ['red-panda', 'cream-cat', 'white-fox']) {
      const directory = path.resolve('src/pets/assets', id);
      const manifest = validatePetManifest(
        JSON.parse(await fs.readFile(path.join(directory, 'pet.json'), 'utf8'))
      );
      expect(manifest.id).toBe(id);
      const bytes = await fs.readFile(path.join(directory, manifest.image));
      expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([1152, 1664]);
      expect(bytes[25]).toBe(6); // PNG IHDR RGBA, preserving the transparent desktop boundary.
      expect(bytes.length).toBeLessThan(20 * 1024 * 1024);
      hashes.add(createHash('sha256').update(bytes).digest('hex'));
    }
    expect(hashes.size).toBe(3);
  });
});
