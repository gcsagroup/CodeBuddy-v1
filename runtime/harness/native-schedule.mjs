import './native-schedule-contract.mjs';
const { default: NativeSchedule } = await import('@deepseek-ai/dsh-schedule');
import { installScheduleControls } from './native-schedule-controls.mjs';

// Schedule keeps its own timer, storage, inbox delivery and retention. This
// scope only prepares the existing product session before native restoration.
export async function mountNativeSchedule(ctx, { prepareSession, onChanged } = {}) {
  const scope = ctx.isolate('sessionController');
  scope.provide('sessionController', {
    async resolveAgent(sessionId) {
      await prepareSession?.(sessionId);
      return ctx.sessionController.resolveAgent(sessionId);
    },
  });
  const fiber = scope.plugin(NativeSchedule, {});
  await fiber;
  if (fiber.state !== 2 || !ctx.get('schedule')) {
    await fiber.dispose();
    throw new Error('The native DSH Schedule service did not activate');
  }
  if (onChanged) ctx.on('schedule/changed', () => { onChanged(); });
  installScheduleControls(scope);
  return ctx.schedule;
}
