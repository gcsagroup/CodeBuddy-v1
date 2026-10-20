import type { PetManifest, PetPreferences, PetTask } from './petTypes';

export const builtinPetIds = ['red-panda', 'cream-cat', 'white-fox'] as const;
export const defaultPetId = builtinPetIds[0];
export const petPanelWidth = 320;
export const petPanelHeight = 272;

export const defaultPetPreferences: PetPreferences = {
  visible: false,
  selectedId: defaultPetId,
  size: 160,
  reducedMotion: false,
};
export function validatePetManifest(value: unknown): PetManifest {
  const m = value as Partial<PetManifest> | null;
  if (
    !m ||
    m.schemaVersion !== 1 ||
    typeof m.id !== 'string' ||
    !/^[a-z][a-z0-9-]{0,47}$/.test(m.id) ||
    typeof m.name !== 'string' ||
    !m.name.trim() ||
    m.name.length > 80 ||
    typeof m.description !== 'string' ||
    m.description.length > 500 ||
    m.image !== 'sprites.png' ||
    m.columns !== 6 ||
    m.rows !== 8 ||
    m.cellWidth !== 192 ||
    m.cellHeight !== 208 ||
    typeof m.fps !== 'number' ||
    !Number.isFinite(m.fps) ||
    m.fps < 2 ||
    m.fps > 16
  ) {
    throw new Error('Invalid pet.json: expected schema 1, 6×8 cells of 192×208, fps 2–16');
  }
  return m as PetManifest;
}
export function normalizePetPreferences(value: unknown): PetPreferences {
  const p = (value || {}) as Partial<PetPreferences>;
  return {
    visible: p.visible === true,
    selectedId:
      typeof p.selectedId === 'string' && p.selectedId !== 'buddy' ? p.selectedId : defaultPetId,
    size:
      typeof p.size === 'number' && Number.isFinite(p.size)
        ? Math.max(96, Math.min(256, Math.round(p.size)))
        : 160,
    reducedMotion: p.reducedMotion === true,
    ...(p.position && Number.isFinite(p.position.x) && Number.isFinite(p.position.y)
      ? { position: { x: Math.round(p.position.x), y: Math.round(p.position.y) } }
      : {}),
  };
}
export function restorePetBounds(
  p: PetPreferences,
  areas: Array<{ x: number; y: number; width: number; height: number }>
) {
  const area =
    areas.find(
      (a) =>
        p.position &&
        p.position.x >= a.x &&
        p.position.x < a.x + a.width &&
        p.position.y >= a.y &&
        p.position.y < a.y + a.height
    ) || areas[0];
  const width = petPanelWidth;
  const height = Math.round((p.size * 208) / 192) + petPanelHeight;
  return {
    width,
    height,
    x: Math.round(
      Math.max(
        area.x,
        Math.min(p.position?.x ?? area.x + area.width - width - 32, area.x + area.width - width)
      )
    ),
    y: Math.round(
      Math.max(
        area.y,
        Math.min(p.position?.y ?? area.y + area.height - height - 24, area.y + area.height - height)
      )
    ),
  };
}
export function selectPetTask(tasks: PetTask[]): PetTask | null {
  return sortPetTasks(tasks)[0] || null;
}
export function sortPetTasks(tasks: PetTask[]): PetTask[] {
  const priority = { idle: 0, working: 1, completed: 2, blocked: 3, input: 4 };
  return tasks
    .filter((t) => t.state !== 'idle')
    .sort((a, b) => priority[b.state] - priority[a.state]);
}
