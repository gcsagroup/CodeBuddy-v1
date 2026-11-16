import type { PetManifest, PetPreferences, PetTask } from './petTypes';

export const builtinPetIds = ['red-panda', 'cream-cat', 'white-fox'] as const;
export const defaultPetId = builtinPetIds[0];
export const petPanelWidth = 320;
export const petPanelHeight = 272;

export const defaultPetPreferences: PetPreferences = {
  visible: false,
  selectedId: '',
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
  const selectedId =
    typeof p.selectedId === 'string'
      ? p.selectedId === 'buddy'
        ? defaultPetId
        : p.selectedId
      : '';
  return {
    visible: p.visible === true && selectedId !== '',
    selectedId,
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
  const width = petPanelWidth;
  const height = Math.round((p.size * 208) / 192) + petPanelHeight;
  const position = p.position ?? {
    x: areas[0].x + areas[0].width - width - 32,
    y: areas[0].y + areas[0].height - height - 24,
  };
  // A transparent pet window can span adjacent displays. Test the union, not
  // the display containing its invisible top-left corner.
  const xs = [
    ...new Set([
      position.x,
      position.x + width,
      ...areas
        .flatMap((a) => [a.x, a.x + a.width])
        .filter((x) => x > position.x && x < position.x + width),
    ]),
  ].sort((a, b) => a - b);
  const covered = xs.slice(0, -1).every((left, i) => {
    const spans = areas
      .filter((a) => a.x <= left && a.x + a.width >= xs[i + 1])
      .sort((a, b) => a.y - b.y);
    let bottom = position.y;
    for (const a of spans) {
      if (a.y > bottom) break;
      bottom = Math.max(bottom, a.y + a.height);
    }
    return bottom >= position.y + height;
  });
  if (covered) return { ...position, width, height };
  // A removed display or an outer edge needs recovery to the closest work area.
  const candidates = areas.map((area) => ({
    x: Math.round(Math.max(area.x, Math.min(position.x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(position.y, area.y + area.height - height))),
    width,
    height,
  }));
  return candidates.sort(
    (a, b) =>
      Math.hypot(a.x - position.x, a.y - position.y) -
      Math.hypot(b.x - position.x, b.y - position.y)
  )[0];
}
export function selectPetTask(tasks: PetTask[]): PetTask | null {
  return sortPetTasks(tasks)[0] || null;
}
export function sortPetTasks(tasks: PetTask[]): PetTask[] {
  const priority = { idle: 0, working: 1, completed: 2, blocked: 3, input: 4 };
  return tasks
    .filter((t) => t.state !== 'idle' || t.questions?.length)
    .sort((a, b) => Number(Boolean(b.questions?.length)) - Number(Boolean(a.questions?.length)) ||
      priority[b.state] - priority[a.state]);
}
