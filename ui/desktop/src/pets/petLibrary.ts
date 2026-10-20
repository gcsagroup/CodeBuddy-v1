import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validatePetManifest } from './petPolicy';
import type { PetAsset } from './petTypes';

export interface PetPixels {
  width: number;
  height: number;
  rgba: Uint8Array;
}
export function validatePetPixels({ width, height, rgba }: PetPixels) {
  if (width !== 1152 || height !== 1664 || rgba.length !== width * height * 4) {
    throw new Error('sprites.png must be 1152×1664 RGBA (6×8 cells)');
  }
  for (let row = 0; row < 8; row++) {
    const frames = new Set<string>();
    for (let frame = 0; frame < 6; frame++) {
      let occupied = 0;
      const hash = createHash('sha256');
      for (let y = 0; y < 208; y++) {
        const start = ((row * 208 + y) * width + frame * 192) * 4;
        const line = rgba.subarray(start, start + 192 * 4);
        hash.update(line);
        for (let x = 0; x < 192; x++) {
          if (line[x * 4 + 3] > 16) {
            occupied++;
            if (x < 2 || x > 189 || y < 2 || y > 205)
              throw new Error(`Clipped frame ${row}:${frame}`);
          }
        }
      }
      if (occupied < 100 || occupied > 192 * 208 * 0.85)
        throw new Error(`Empty or opaque frame ${row}:${frame}`);
      frames.add(hash.digest('hex'));
    }
    if (frames.size < 3)
      throw new Error(`Animation row ${row} needs at least three distinct frames`);
  }
}

export async function loadPetAsset(
  directory: string,
  builtin: boolean,
  decode: (buffer: Buffer) => PetPixels
): Promise<PetAsset> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  if (
    entries.some((e) => e.isSymbolicLink()) ||
    !(await fs.lstat(directory)).isDirectory() ||
    (await fs.lstat(directory)).isSymbolicLink()
  )
    throw new Error('Pet packages must contain ordinary local files');
  const manifestFile = path.join(directory, 'pet.json');
  if ((await fs.stat(manifestFile)).size > 8192) throw new Error('pet.json exceeds 8 KiB');
  const manifest = validatePetManifest(JSON.parse(await fs.readFile(manifestFile, 'utf8')));
  const file = path.join(directory, manifest.image);
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 20 * 1024 * 1024 || stat.size < 24)
    throw new Error('Pet image must be PNG, at most 20 MiB');
  const bytes = await fs.readFile(file);
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    throw new Error('Invalid PNG signature');
  // Check IHDR before decoding to bound image allocation.
  if (bytes.readUInt32BE(16) !== 1152 || bytes.readUInt32BE(20) !== 1664)
    throw new Error('Invalid PNG dimensions');
  validatePetPixels(decode(bytes));
  return {
    ...manifest,
    builtin,
    hash: createHash('sha256').update(bytes).digest('hex'),
    imageUrl: `data:image/png;base64,${bytes.toString('base64')}`,
  };
}
