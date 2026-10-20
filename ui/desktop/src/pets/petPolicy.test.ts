import { describe, expect, it } from 'vitest';
import {
  normalizePetPreferences,
  restorePetBounds,
  selectPetTask,
  validatePetManifest,
} from './petPolicy';
import { validatePetPixels } from './petLibrary';

describe('desktop pet boundaries', () => {
  it('defaults to the red panda and preserves an explicitly selected alternative', () => {
    expect(normalizePetPreferences({}).selectedId).toBe('red-panda');
    expect(normalizePetPreferences({ selectedId: 'buddy' }).selectedId).toBe('red-panda');
    for (const selectedId of ['cream-cat', 'white-fox', 'my-custom-pet']) {
      expect(normalizePetPreferences({ selectedId }).selectedId).toBe(selectedId);
    }
  });
  it('uses the requested attention priority without interpreting prose', () => {
    const tasks = ['working', 'completed', 'blocked', 'input'].map((state) => ({
      sessionId: state,
      title: 'completed failed waiting',
      state,
    })) as Parameters<typeof selectPetTask>[0];
    expect(selectPetTask(tasks)?.state).toBe('input');
    expect(selectPetTask(tasks.slice(0, 3))?.state).toBe('blocked');
    expect(selectPetTask(tasks.slice(0, 2))?.state).toBe('completed');
    expect(selectPetTask([])).toBeNull();
  });
  it('restores size and position inside current display work areas', () => {
    const p = normalizePetPreferences({
      visible: true,
      size: 999,
      selectedId: 'test',
      position: { x: -2000, y: 9999 },
    });
    expect(p.size).toBe(256);
    const b = restorePetBounds(p, [{ x: 0, y: 0, width: 1920, height: 1040 }]);
    expect(b.x).toBe(0);
    expect(b.y + b.height).toBe(1040);
    const second = restorePetBounds({ ...p, position: { x: -1100, y: 50 } }, [
      { x: 0, y: 0, width: 1920, height: 1040 },
      { x: -1280, y: 0, width: 1280, height: 720 },
    ]);
    expect(second.x).toBe(-1100);
    expect(normalizePetPreferences({ size: NaN, visible: 'yes' }).visible).toBe(false);
  });
  it('rejects executable and path-bearing manifests, missing rows and opaque art', () => {
    const manifest = {
      schemaVersion: 1,
      id: 'test',
      name: 'Test',
      description: '',
      image: 'sprites.png',
      columns: 6,
      rows: 8,
      cellWidth: 192,
      cellHeight: 208,
      fps: 6,
    };
    expect(validatePetManifest(manifest).id).toBe('test');
    expect(() => validatePetManifest({ ...manifest, image: '../x.png' })).toThrow();
    expect(() => validatePetManifest({ ...manifest, id: '../test' })).toThrow();
    expect(() => validatePetManifest({ ...manifest, rows: 7 })).toThrow();
    expect(() =>
      validatePetPixels({ width: 1152, height: 1664, rgba: new Uint8Array(1152 * 1664 * 4) })
    ).toThrow(/Empty/);
    expect(() =>
      validatePetPixels({
        width: 1152,
        height: 1664,
        rgba: new Uint8Array(1152 * 1664 * 4).fill(255),
      })
    ).toThrow(/Clipped/);
  });
  it('keeps drops across adjacent monitor seams in both directions, including negative coordinates', () => {
    const p = normalizePetPreferences({ size: 160 });
    const areas = [
      { x: -1920, y: 0, width: 1920, height: 1040 },
      { x: 0, y: 0, width: 2560, height: 1400 },
    ];
    for (const x of [-240, -160, -40, 20]) {
      expect(restorePetBounds({ ...p, position: { x, y: 400 } }, areas)).toMatchObject({
        x,
        y: 400,
      });
    }
    const stacked = [
      { x: 0, y: -1080, width: 1920, height: 1080 },
      { x: 0, y: 0, width: 1920, height: 1040 },
    ];
    expect(restorePetBounds({ ...p, position: { x: 500, y: -100 } }, stacked)).toMatchObject({
      x: 500,
      y: -100,
    });
  });
  it('recovers outer edges and gaps to the closest display instead of the first display', () => {
    const p = normalizePetPreferences({ size: 160 });
    const areas = [
      { x: 0, y: 0, width: 1920, height: 1040 },
      { x: 1920, y: 200, width: 1600, height: 1000 },
    ];
    expect(restorePetBounds({ ...p, position: { x: 3500, y: 300 } }, areas)).toMatchObject({
      x: 3200,
      y: 300,
    });
    expect(restorePetBounds({ ...p, position: { x: 1850, y: 50 } }, areas)).toMatchObject({
      x: 1920,
      y: 200,
    });
  });
});
