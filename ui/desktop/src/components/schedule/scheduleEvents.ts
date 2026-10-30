export const NATIVE_SCHEDULE_CHANGED = 'codebuddy:native-schedules-changed';
export const OPEN_NATIVE_SCHEDULE = 'codebuddy:open-native-schedule';
export function openNativeSchedule(id: string) {
  window.dispatchEvent(new CustomEvent(OPEN_NATIVE_SCHEDULE, { detail: { id } }));
}
