import sharp from 'sharp';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export async function inspectImage(file, { columns = 1, rows = 1 } = {}) {
  if (![columns, rows].every(n => Number.isInteger(n) && n >= 1 && n <= 24)) throw Error('Grid dimensions must be integers from 1 to 24');
  const info = await stat(file);
  if (!info.isFile() || info.size > 64 * 1024 * 1024) throw Error('Image must be a file under 64 MiB');
  const bytes = await readFile(file);
  const metadata = await sharp(bytes, { limitInputPixels: 64 * 1024 * 1024 }).metadata();
  const { data, info: raw } = await sharp(bytes, { animated: true, limitInputPixels: 64 * 1024 * 1024 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pageHeight = metadata.pageHeight ?? raw.height;
  if (raw.width % columns || pageHeight % rows) throw Error('Grid must divide the image dimensions exactly');
  const width = raw.width / columns, height = pageHeight / rows;
  const frames = [];
  for (let page = 0; page < (metadata.pages ?? 1); page++) {
    for (let cell = 0; cell < columns * rows; cell++) {
      const ox = (cell % columns) * width, oy = page * pageHeight + Math.floor(cell / columns) * height;
      let left = width, top = height, right = -1, bottom = -1, pixels = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const alpha = data[((oy + y) * raw.width + ox + x) * raw.channels + raw.channels - 1];
          if (alpha < 16) continue;
          left = Math.min(left, x); right = Math.max(right, x);
          top = Math.min(top, y); bottom = Math.max(bottom, y); pixels++;
        }
      }
      frames.push({ page, cell, delayMs: metadata.delay?.[page] ?? null, bounds: pixels ? { left, top, right, bottom } : null, visiblePixels: pixels,
        touchesEdge: pixels > 0 && (left === 0 || top === 0 || right === width - 1 || bottom === height - 1) });
    }
  }
  const visible = frames.filter(frame => frame.bounds);
  return { width: raw.width, height: pageHeight, frameWidth: width, frameHeight: height, hasAlpha: metadata.hasAlpha, frames,
    stableBounds: visible.length ? { left: Math.min(...visible.map(f => f.bounds.left)), top: Math.min(...visible.map(f => f.bounds.top)),
      right: Math.max(...visible.map(f => f.bounds.right)), bottom: Math.max(...visible.map(f => f.bounds.bottom)) } : null };
}

if (process.argv[1] && await realpath(process.argv[1]) === await realpath(new URL(import.meta.url))) {
  try { console.log(JSON.stringify(await inspectImage(path.resolve(process.argv[2]), { columns: Number(process.argv[3] ?? 1), rows: Number(process.argv[4] ?? 1) }))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
